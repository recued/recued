/**
 * Inlined icon registry — this file is the canonical source for
 * shared SVG glyphs as of D-148 P11. The original generator and its
 * source SVGs lived under `apps/extension/` and were retired with
 * the extension; the inlined strings below are now the artifact of
 * record. Edit the entries directly when an icon needs to change.
 *
 * Each value is the raw SVG markup of the icon with any XML
 * declaration stripped. Templates inline the strings directly so
 * they can theme via `currentColor` and avoid extra HTTP requests
 * for sub-kilobyte glyphs.
 */

export const ICONS = Object.freeze({
  "action": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Recued">
  <title>Recued toolbar action</title>
  <desc>Recued toolbar icon — paprika rounded square with R and tray.</desc>
  <rect x="1" y="1" width="30" height="30" rx="6" ry="6" fill="#C1440E"/>
  <!-- Simplified R -->
  <path
    fill="#fff"
    fill-rule="evenodd"
    d="M9 7h7a4 4 0 0 1 0 8h-2l7 7h-4l-4-6v6h-4z
       M13 9.5h3a1.5 1.5 0 0 1 0 3h-3z"
  />
  <!-- Tray -->
  <rect x="6" y="24" width="20" height="2" rx="1" fill="#fff"/>
  <!-- Left handle -->
  <line x1="5" y1="24" x2="3" y2="20" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
  <!-- Right handle -->
  <line x1="27" y1="24" x2="29" y2="20" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
</svg>`,
  "check": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Success">
  <title>Success</title>
  <desc>Checkmark. Used to indicate successful runs and ok checklist items.</desc>
  <polyline points="5 12 10 17 19 6"/>
</svg>`,
  "info": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Info">
  <title>Info</title>
  <desc>Information glyph. Reserved for inline hints and tooltips.</desc>
  <circle cx="12" cy="12" r="9"/>
  <line x1="12" y1="11" x2="12" y2="17"/>
  <circle cx="12" cy="8" r="0.5" fill="currentColor"/>
</svg>`,
  "logo": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Recued">
  <title>Recued</title>
  <desc>Recued logo — paprika rounded square with R letterform and serving tray handles.</desc>
  <rect x="4" y="4" width="120" height="120" rx="22" ry="22" fill="#C1440E"/>
  <!-- R letterform -->
  <path
    fill="#fff"
    fill-rule="evenodd"
    d="M38 28h24a14 14 0 0 1 0 28h-6l24 26h-14l-14-22v22h-14z
       M52 38h8a5 5 0 0 1 0 10h-8z"
  />
  <!-- Tray base -->
  <rect x="24" y="88" width="80" height="5" rx="2.5" fill="#fff"/>
  <!-- Left handle -->
  <line x1="20" y1="88" x2="14" y2="74" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
  <line x1="14" y1="74" x2="8" y2="74" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
  <!-- Right handle -->
  <line x1="108" y1="88" x2="114" y2="74" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
  <line x1="114" y1="74" x2="120" y2="74" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
</svg>`,
  "marketplace": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Marketplace">
  <title>Marketplace</title>
  <desc>Storefront icon. Used on "Browse marketplace" links.</desc>
  <path d="M3 9l1 -4h16l1 4"/>
  <path d="M3 9v11h18v-11"/>
  <path d="M3 9a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 2 0"/>
  <path d="M10 20v-5h4v5"/>
</svg>`,
  "play": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="Run recipe">
  <title>Run recipe</title>
  <desc>Play triangle. Used on recipe Run buttons in popup and sidebar.</desc>
  <path d="M8 5v14l11-7z"/>
</svg>`,
  "settings": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Settings">
  <title>Settings</title>
  <desc>Gear icon. Used by popup/sidebar/options for the settings button.</desc>
  <circle cx="12" cy="12" r="3"/>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
</svg>`,
  "spinner": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Running">
  <title>Running</title>
  <desc>Spinner ring for in-progress recipe runs. CSS animation supplies the rotation.</desc>
  <path d="M21 12a9 9 0 0 1-9 9"/>
</svg>`,
  "x": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Failure">
  <title>Failure</title>
  <desc>X mark. Used to indicate failed runs and issue checklist items.</desc>
  <line x1="6" y1="6" x2="18" y2="18"/>
  <line x1="18" y1="6" x2="6" y2="18"/>
</svg>`,
  "task": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Tasks">
  <title>Tasks</title>
  <desc>Checklist with two checkboxes. Used in primary nav for the task work-entity surface.</desc>
  <rect x="4" y="4" width="6" height="6" rx="1.25"/>
  <polyline points="5.5 7 7 8.5 9 5.5"/>
  <rect x="4" y="14" width="6" height="6" rx="1.25"/>
  <line x1="13" y1="6.5" x2="20" y2="6.5"/>
  <line x1="13" y1="9.5" x2="18" y2="9.5"/>
  <line x1="13" y1="16.5" x2="20" y2="16.5"/>
  <line x1="13" y1="19.5" x2="18" y2="19.5"/>
</svg>`,
  "note": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Notes">
  <title>Notes</title>
  <desc>Document with text lines and a folded corner. Used in primary nav for the note work-entity surface.</desc>
  <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
  <polyline points="14 3 14 9 20 9"/>
  <line x1="8" y1="13" x2="16" y2="13"/>
  <line x1="8" y1="16" x2="14" y2="16"/>
</svg>`,
  "booking": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Bookings">
  <title>Bookings</title>
  <desc>Calendar with a check. Used in primary nav for the booking work-entity surface.</desc>
  <rect x="3" y="5" width="18" height="16" rx="2"/>
  <line x1="3" y1="10" x2="21" y2="10"/>
  <line x1="8" y1="3" x2="8" y2="7"/>
  <line x1="16" y1="3" x2="16" y2="7"/>
  <path d="M9 14.5l2 2 4-4"/>
</svg>`,
  "commitment": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Commitments">
  <title>Commitments</title>
  <desc>Handshake — two clasping forearms. Used in primary nav for the commitment work-entity surface.</desc>
  <path d="M3 12l4-4 3 3 3-3 4 4-3 3-3-3-3 3z"/>
  <line x1="3" y1="12" x2="3" y2="15"/>
  <line x1="21" y1="12" x2="21" y2="15"/>
</svg>`,
  "project": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Projects">
  <title>Projects</title>
  <desc>Folder with a small tab. Used in primary nav for the project work-entity surface.</desc>
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
  <line x1="3" y1="11" x2="21" y2="11"/>
</svg>`,
}) as Record<IconName, string>;

export type IconName =
  | "action"
  | "booking"
  | "check"
  | "commitment"
  | "info"
  | "logo"
  | "marketplace"
  | "note"
  | "play"
  | "project"
  | "settings"
  | "spinner"
  | "task"
  | "x";

export const ICON_NAMES: readonly IconName[] = Object.freeze([
  "action",
  "booking",
  "check",
  "commitment",
  "info",
  "logo",
  "marketplace",
  "note",
  "play",
  "project",
  "settings",
  "spinner",
  "task",
  "x",
]);
