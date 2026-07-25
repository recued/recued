/** D-210 Appendix B — `reception.manage.mint`: the owner mints an on-the-go
 *  reschedule link for one canonical booking.
 *
 *  Reserved admin-only rpc (the whole `reception.` prefix is in
 *  `MCP_RESERVED_RPC_PREFIXES`), so this is a paired-client-only surface and
 *  implies no grant work. The result carries the single-use link secret back to
 *  the owner's own client — the same posture as the seller-claim link.
 *
 *  ## Why the result is a PATH, not a full URL
 *
 *  A WS rpc has no request Host, and `getShareBaseUrl` throws on a private/LAN
 *  host — so the server cannot honestly build the absolute link. The webclient
 *  can: it is already connected to the server over whatever host (LAN IP or
 *  DDNS), so it prepends its own origin. That is exactly the owner's "no host
 *  constraint — LAN benefits" ruling: the link works on the LAN listener with no
 *  public domain.
 *
 *  Spec: D-210 Appendix B. */

export interface ReceptionManageMintInput {
  /** The `data.booking` row to mint a reschedule link for. Its originating
   *  reservation is resolved SERVER-SIDE from the booking's own
   *  `reception_record_id`, so only a RECEPTION booking can be minted — one the
   *  owner entered by hand has no sealed visitor to hand a link to (and
   *  reschedules at-desk via R-4 instead).
   *
   *  ⚠ Was `event_source_id` (a calendar event) until D-210 A.2 — booking ⟂
   *  calendar means a reservation has no event to name. */
  readonly booking_id: string;
}

export interface ReceptionManageMintResult {
  /** The relative link path INCLUDING the single-use secret
   *  (`/reception/manage/<secret>`). The webclient prepends its own origin. */
  readonly manage_path: string;
  /** Credential expiry (unix ms) — surfaced so the owner knows the link is
   *  short-lived. */
  readonly expires_at: number;
}
