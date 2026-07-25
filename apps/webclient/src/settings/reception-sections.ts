/** Reception sections — the `#reception` sub-router vocabulary (R19).
 *
 *  R19 splits the one-long-page Reception surface into sections,
 *  ordered by frequency-of-use, each a deep-link under the `reception`
 *  route (a `WEBCLIENT_DEEP_LINK_ROUTES` member):
 *
 *    - **Inbox** (`#reception/inbox`)     — DEFAULT. The D-173 review
 *      queue: read-and-decide incoming requests. Most frequent.
 *    - **Records** (`#reception/records`) — D-210 §4c. Every reception
 *      row as its owner reads it, read-only (the record is write-once —
 *      §4). The one surface that can show a row the drain HELD: it has
 *      no held op for the Inbox and no destination for `#data`.
 *    - **Abuse** (`#reception/abuse`)     — abuse-signal clusters + the
 *      per-server IP block list. Promoted from a buried CTA.
 *    - **Endpoints** (`#reception/endpoints`) — the doors you author /
 *      manage. Set-and-forget, so last.
 *
 *  A section is segment 0 of the parsed `#reception/<section>` hash. A
 *  bare `#reception` (no segment) resolves to the default (Inbox). This
 *  module owns ONLY the closed-list vocabulary + the chrome styles —
 *  the bootstrap builds the nav anchors as DOM nodes (mirroring
 *  `bootstrap-connections-route.ts`, which builds `#connections/<tab>`
 *  anchors the same way) so the nav stays queryable under the webclient's
 *  no-jsdom fake-host test pattern.
 *
 *  Deeper segments (`#reception/endpoints/new/<kind>`, `#reception/setup`,
 *  `#reception/endpoints/<id>`) are later R19 slices; they ride the same
 *  deep-link re-mount and resolve their section here (segment 0 stays
 *  `endpoints`).
 *
 *  Design record: internal design notes §9
 *  + Review log R19 / R19.1. */

// ════════════════════════════════════════════════════════════════
// Section vocabulary
// ════════════════════════════════════════════════════════════════

/** The sections in their locked frequency order (Inbox first = default;
 *  Endpoints last = set-and-forget). The label is the nav text.
 *
 *  D-210 §4c adds **Records** in second place, directly beside the Inbox:
 *  the two answer the same question ("what came in?") for rows at
 *  different stages, and a record the drain could not hand off is
 *  precisely what the Inbox CANNOT show — no held op to join. Putting it
 *  third or later would file the fallback further from the surface whose
 *  gap it covers. */
export const RECEPTION_SECTIONS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'records', label: 'Records' },
  { id: 'abuse', label: 'Abuse' },
  { id: 'endpoints', label: 'Endpoints' },
] as const;

export type ReceptionSection = (typeof RECEPTION_SECTIONS)[number]['id'];

/** The section a bare `#reception` (or an unknown segment) lands on. */
export const RECEPTION_DEFAULT_SECTION: ReceptionSection = 'inbox';

/** Resolve a raw deep-link segment-0 value to a known section. An absent
 *  or unrecognized value degrades to the default (Inbox) — the router
 *  must never reject a hash (mirrors `parseShellRoute`'s
 *  unknown-surface-degrades-to-default posture). */
export const resolveReceptionSection = (
  raw: string | undefined,
): ReceptionSection =>
  RECEPTION_SECTIONS.some((s) => s.id === raw)
    ? (raw as ReceptionSection)
    : RECEPTION_DEFAULT_SECTION;

// ════════════════════════════════════════════════════════════════
// Route chrome attributes + styles
// ════════════════════════════════════════════════════════════════

export const RECEPTION_ROUTE_HOST_ATTR = 'data-recued-reception-route';
export const RECEPTION_ROUTE_TABS_ATTR = 'data-recued-reception-route-tabs';
export const RECEPTION_ROUTE_CONTENT_ATTR =
  'data-recued-reception-route-content';

/** Chrome styles for the sectioned route — the max-width host, route
 *  introduction, and compact segmented navigation. */
export const RECEPTION_SECTION_NAV_STYLES = `
[${RECEPTION_ROUTE_HOST_ATTR}] {
  max-width: var(--wc-content-max, 1160px);
  margin: 0 auto;
  padding: clamp(18px, 3vw, 30px);
  color: var(--fg);
}
[${RECEPTION_ROUTE_HOST_ATTR}] .reception-route-header {
  display: grid;
  gap: 6px;
  margin-bottom: 20px;
}
[${RECEPTION_ROUTE_HOST_ATTR}] .reception-route-title {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0;
  font-size: clamp(24px, 3vw, 30px);
  font-weight: 720;
  line-height: 1.15;
  letter-spacing: -0.025em;
}
[${RECEPTION_ROUTE_HOST_ATTR}] .reception-route-title::before {
  content: "";
  width: 11px;
  height: 11px;
  border-radius: 4px;
  background: var(--accent);
  box-shadow: 0 0 0 5px var(--accent-weak);
}
[${RECEPTION_ROUTE_HOST_ATTR}] .reception-route-subtitle {
  max-width: 660px;
  margin: 0;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.55;
}
[${RECEPTION_ROUTE_TABS_ATTR}] {
  display: inline-flex;
  gap: 4px;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 22px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-sunk);
}
[${RECEPTION_ROUTE_TABS_ATTR}] .reception-route-tab {
  appearance: none;
  text-decoration: none;
  min-height: 36px;
  padding: 8px 15px;
  border-radius: 8px;
  font-weight: 650;
  font-size: 13px;
  color: var(--fg-muted);
  cursor: pointer;
  transition: color 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
}
[${RECEPTION_ROUTE_TABS_ATTR}] .reception-route-tab:hover {
  color: var(--fg);
  background: color-mix(in srgb, var(--surface) 55%, transparent);
}
[${RECEPTION_ROUTE_TABS_ATTR}] .reception-route-tab--active {
  color: var(--fg);
  background: var(--surface);
  box-shadow: 0 1px 3px rgba(24, 24, 27, 0.10);
}
[${RECEPTION_ROUTE_TABS_ATTR}] .reception-route-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
/* The route host already owns the outer padding; the endpoints-spine + abuse-section
   reception-page block would otherwise double it. Neutralize the inner
   pad so the section content aligns with the header + tab bar. */
[${RECEPTION_ROUTE_CONTENT_ATTR}] .reception-page {
  padding: 0;
}
@media (max-width: 720px) {
  [${RECEPTION_ROUTE_HOST_ATTR}] {
    padding: 18px 14px 28px;
  }
  [${RECEPTION_ROUTE_TABS_ATTR}] {
    display: flex;
    width: 100%;
  }
  [${RECEPTION_ROUTE_TABS_ATTR}] .reception-route-tab {
    flex: 1;
    padding-inline: 10px;
    text-align: center;
  }
}
`;
