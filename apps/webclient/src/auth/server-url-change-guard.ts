/** D-148 — may this `server_url` change be saved?
 *
 *  ⛔ ONE CONDITION, NOT TWO: the candidate must be ALIVE AND PROVE THE PINNED
 *  IDENTITY. Not merely alive — an attacker's host is trivially alive. The
 *  probe (`auth/identity-probe.ts`) makes the candidate sign a fresh nonce
 *  with the key this client pinned, so an address that cannot produce that
 *  signature can never be saved. ⇒ Nothing is persisted unless a server at the
 *  new address JUST proved it is the same server.
 *
 *  ## ⛔ THE SELF-SEVERING REFUSAL WAS REMOVED 2026-09-17 — IT WAS THE RIGHT
 *  ## RULE ON THE WRONG OPERATION
 *
 *  This module briefly refused a change made THROUGH the address being changed
 *  (connected on 443, editing 443 → 4433). The owner asked the obvious
 *  question — *"if the signature is the same, key & cert is the same, why
 *  wouldn't swapping url be safe?"* — and it is. Three facts, each verified:
 *
 *  1. ⚠ `server_url` IS WEBCLIENT-LOCAL STORAGE — a profile's identity in
 *     `storage/local-store.ts`. Writing it rebinds no listener and closes no
 *     socket. The server never reads a client-supplied `server_url`; its own
 *     occurrences are its OWN origin, for the OAuth callback.
 *  2. The probe is an HTTP POST to an independent origin. It does not ride the
 *     current WebSocket. The justification written into the design doc — *"the
 *     probe cannot run from a socket the change is about to close"* — was true
 *     of the WS probe that got replaced, and nobody revisited it.
 *  3. ⇒ Connected on 443 and saving 4433 severs nothing. The socket stays up;
 *     the client dials the new address next time.
 *
 *  🔑 AND THE REFUSAL BLOCKED THE EXACT MIGRATION THE FEATURE EXISTS FOR:
 *  running behind existing web hosting means being connected on one port and
 *  pointing the client at another.
 *
 *  ⚠ THE RULE ITSELF IS SOUND — FOR THE OTHER OPERATION. It came from the
 *  `public_port` discussion, where changing the SERVER's port really does
 *  rebind the listener and kill the connection carrying the confirmation.
 *  That guard belongs on the server-side port editor, not here. Attaching it
 *  to a client-side pointer edit was a category error: two different changes,
 *  one of which touches the server and one of which does not.
 */

import type { IdentityProbeOutcome } from './identity-probe.js';

/** Default ports the URL grammar leaves implicit. Without this,
 *  `wss://h/ws` and `wss://h:443/ws` compare as different addresses and the
 *  self-severing guard below silently stops firing for the exact case it was
 *  written for — a change from an implicit 443. */
const DEFAULT_PORT_FOR_PROTOCOL: Readonly<Record<string, string>> = {
  'wss:': '443',
  'https:': '443',
  'ws:': '80',
  'http:': '80',
};

/** `host:port` with the implicit port made explicit, or null if unparseable.
 *  Scheme and path are deliberately dropped: `wss://h:8443/ws` and
 *  `https://h:8443/` are the same listener, and the question here is which
 *  listener an edit travels through. */
export const addressIdentity = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    const port = parsed.port || DEFAULT_PORT_FOR_PROTOCOL[parsed.protocol];
    if (!port) return null;
    return `${parsed.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
};

/** `host:port<mount>` — the address identity PLUS the mount prefix.
 *
 *  ⛔ SEPARATE FROM `addressIdentity` BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
 *  `addressIdentity` asks "which listener", and for that a path is noise. This
 *  asks "which SERVER", and behind a reverse proxy the path is the only thing
 *  that distinguishes them: two Recued instances mounted at
 *  `https://example.com/recued-a/` and `/recued-b/` share a host and a port and
 *  are not the same server. Using the listener identity for a
 *  "you already have that one" check would refuse a legitimate second server.
 *
 *  The `/ws` leaf is stripped so the stored WS URL and the base a user types
 *  compare equal. */
export const serverMountIdentity = (url: string): string | null => {
  const listener = addressIdentity(url);
  if (listener === null) return null;
  try {
    const mount = new URL(url).pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '');
    return `${listener}${mount}`;
  } catch {
    return null;
  }
};

export type ServerUrlChangeVerdict =
  | { readonly kind: 'save' }
  /** The candidate did not prove it is this server (or did not answer). */
  | { readonly kind: 'refuse_unproven'; readonly probe: IdentityProbeOutcome }
  /** An address this client cannot even parse never becomes a saved address. */
  | { readonly kind: 'refuse_unparseable' };

export interface ServerUrlChangeInput {
  /** The stored URL being replaced. */
  readonly currentUrl: string;
  /** The URL the user typed. */
  readonly candidateUrl: string;
  /** What the probe said about `candidateUrl`. */
  readonly probe: IdentityProbeOutcome;
}

export const decideServerUrlChange = (
  input: ServerUrlChangeInput,
): ServerUrlChangeVerdict => {
  // An address this client cannot parse never becomes a saved address —
  // checked before the probe, so a malformed entry is never contacted.
  if (!addressIdentity(input.currentUrl) || !addressIdentity(input.candidateUrl)) {
    return { kind: 'refuse_unparseable' };
  }

  if (input.probe.kind !== 'verified') {
    return { kind: 'refuse_unproven', probe: input.probe };
  }
  return { kind: 'save' };
};
