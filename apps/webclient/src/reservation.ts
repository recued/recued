/** D-148 § A.4 — webclient package marker.
 *
 *  P1 reserved this directory. P4 fills the implementation. The
 *  marker remains exported so consumers (and the role-boundary lint
 *  test) can sanity-check they imported the right package. */
export const WEBCLIENT_RESERVATION_MARKER = 'recued.webclient.p4.thin' as const;
