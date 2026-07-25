/** D-192 messenger flagship (M1b) — the declaration-driven messenger→contact
 *  link WRITER (closes M3's residual).
 *
 *  M3 landed the READER seam: `resolveMessageCommitmentActor` maps an inbound
 *  matched message's `(vendor, sender)` through the D-138 `contact_platform_link`
 *  table → the sender's canonical email → the commitment's counterparty. But in
 *  production that table has NO messenger rows — nothing writes them, so a
 *  matched sender always stayed opaque (`actor_contact_id` absent, owner fills
 *  at approval). This is the writer M3 deferred to M1.
 *
 *  It is DECLARATION-DRIVEN (kinds-taxonomy §0): the vendor-agnostic logic here
 *  gates on the `MessengerVendorDeclaration`'s `identity.platform_id_source`;
 *  the actual profile→email fetch is a thin per-vendor adapter leaf
 *  (`MESSENGER_PROFILE_EMAIL_LEAVES`) keyed by vendor slug. Slack resolves via
 *  `users.info` (`platform_id_source: 'profile_email'`); Telegram exposes no
 *  email (`'none'`), so it is a structural no-op — no `switch (vendor)` in this
 *  shared code, exactly one map entry per vendor with a leaf.
 *
 *  FAIL-OPEN throughout: a missing dep, an already-linked sender, a
 *  non-`profile_email` vendor, an absent/blank email, or a throwing
 *  fetch/lookup/write is a silent no-op — the sender simply stays opaque and
 *  the owner fills the counterparty at approval (the F1 nullable posture).
 *  Idempotent: the store's `UNIQUE (vendor, platform_id)` upsert makes a
 *  re-link a no-op, and an already-linked sender skips the network round-trip
 *  entirely.
 *
 *  Spec: `docs/d-192-kinds-taxonomy.md` § 3a (M-1). */

import {
  getMessengerVendorDeclaration,
  type MessengerVendorDeclaration,
} from '@recued/contracts';
import { fetchSlackUserEmail } from '@recued/transport';

/** A per-vendor profile→email adapter leaf — given the vendor's bot token + a
 *  sender's platform id, resolve their email (or `null`). Fail-soft (never
 *  throws). */
export type MessengerProfileEmailLeaf = (
  token: string,
  platform_id: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
) => Promise<string | null>;

/** The profile-email adapter registry — one entry per vendor whose declaration
 *  sets `identity.platform_id_source: 'profile_email'`. A new such vendor adds
 *  one leaf here (the §0 per-vendor adapter), never a branch in the writer.
 *  Telegram is deliberately ABSENT (`'none'` — no email). */
export const MESSENGER_PROFILE_EMAIL_LEAVES: Readonly<Record<string, MessengerProfileEmailLeaf>> = {
  slack: (token, platform_id, opts) => fetchSlackUserEmail(token, platform_id, opts ?? {}),
};

/** The `(vendor, platform_id) → canonical_email` link write the store performs
 *  (a structural subset of `PlatformLinkInput` — `state` fixed to `'auto'`
 *  since an auto-derived messenger link is never user-confirmed). */
export interface MessengerPlatformLinkWrite {
  canonical_email: string;
  vendor: string;
  platform_id: string;
  state: 'auto';
  linked_at: number;
  linked_by: string;
  /** D-192 slice 4 — the messenger connection that received the message, so a
   *  connection-teardown retract can cut THIS connection's links precisely. */
  connection_name: string;
}

export interface MessengerSenderLinkDeps {
  /** D-138 link lookup — an already-linked sender skips the profile fetch. */
  lookupPlatformLink: (vendor: string, platform_id: string) => string | null | undefined;
  /** D-138 link writer (`contactStore.linkPlatformId`). */
  linkPlatformId: (input: MessengerPlatformLinkWrite) => void;
  /** Vendor-agnostic profile→email resolver — the wire builds this from the
   *  vendor's bot token + `MESSENGER_PROFILE_EMAIL_LEAVES`. Absent ⇒ no fetch
   *  path ⇒ no-op. Fail-soft (returns null). */
  fetchProfileEmail?: (vendor: string, platform_id: string) => Promise<string | null>;
  /** Registry lookup (defaulted to the built-in registry; overridable for a
   *  live/merged registry or a test). */
  getDeclaration?: (vendor: string) => MessengerVendorDeclaration | null;
  now?: () => number;
}

/** Ensure an inbound messenger sender is linked to a canonical contact email.
 *  Best-effort + fail-open (see file header). Returns nothing — success is a
 *  side-effect (a link row); failure is a silent no-op. */
export const ensureMessengerSenderLinked = async (
  deps: MessengerSenderLinkDeps,
  input: { vendor: string; platform_id: string; connection_name: string },
): Promise<void> => {
  const vendor = input.vendor.trim();
  const platform_id = input.platform_id.trim();
  const connection_name = input.connection_name.trim();
  if (vendor.length === 0 || platform_id.length === 0 || connection_name.length === 0) return;

  // Already linked — skip the network round-trip entirely (idempotent + cheap).
  try {
    const existing = deps.lookupPlatformLink(vendor, platform_id);
    if (existing !== null && existing !== undefined && existing.length > 0) return;
  } catch {
    return; // corrupt link store — fail open
  }

  // The vendor must expose a profile email (Slack); a `'none'` vendor
  // (Telegram) or an undeclared vendor is a structural no-op.
  const getDeclaration = deps.getDeclaration ?? getMessengerVendorDeclaration;
  const declaration = getDeclaration(vendor);
  if (declaration === null || declaration.identity.platform_id_source !== 'profile_email') return;
  if (deps.fetchProfileEmail === undefined) return;

  let email: string | null;
  try {
    email = await deps.fetchProfileEmail(vendor, platform_id);
  } catch {
    return; // the leaf is fail-soft, but guard anyway
  }
  if (email === null) return;
  // Canonical form for the contact store's email key — lowercased + trimmed.
  // The read-side `resolveCanonicalEmail` walks any merge chain, so storing the
  // raw (lowercased) email is correct even before the person is a contact.
  const canonical_email = email.trim().toLowerCase();
  if (canonical_email.length === 0) return;

  const now = deps.now ?? ((): number => Date.now());
  try {
    deps.linkPlatformId({
      canonical_email,
      vendor,
      platform_id,
      state: 'auto',
      // Provenance prefix parallel to the reconciler's `reconciler:<vendor>`.
      linked_by: `messenger:${vendor}`,
      linked_at: now(),
      // D-192 slice 4 — stamp the receiving connection so its teardown can
      // retract exactly these links (the `(vendor, platform_id)` PK cannot).
      connection_name,
    });
  } catch {
    // Best-effort — a write failure just leaves the sender unlinked this pass;
    // a redelivery / the next message from the same sender retries.
  }
};
