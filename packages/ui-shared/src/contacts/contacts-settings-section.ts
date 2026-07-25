/** D-138 Phase 4 — Settings → Contacts section.
 *
 *  Persistent surface for the merge-candidate queue (alongside the
 *  top-bar badge from `merge-badge-slot.ts`). Three affordances:
 *
 *    1. Pending count badge + "Open review" button — opens the
 *       shared `<MergeReviewDialog>` (P2) loaded with the queue via
 *       `contact.merge.list({ status: 'pending' })`.
 *    2. "Scan now" button — fires `contact.merge.scan_now({ mode:
 *       'full' })` (P3 rpc); progress flows through the bus via
 *       `merge_scan_progress` events. Disabled while a scan is in
 *       flight (the host owns the in-flight state).
 *    3. Optional "Rejected pairs" entry-point — deferred to a later
 *       phase per spec § A.10 fallback path. The slot reserves a
 *       `data-action="contact-merge-open-rejected"` hook so the
 *       host can light it up without re-rendering the section.
 *
 *  Pure render module. The host wires data-action clicks to the
 *  rpcs + dialog state; this module just shapes the surface. Spec:
 *  D-138 § A.9 + § P4. */

import { e } from '../template.js';
import { button } from '../primitives/button.js';
import { panel } from '../primitives/panel.js';
import { section } from '../primitives/section.js';

export interface ContactsSettingsSectionState {
  /** Pending merge-candidate count. Mirrored from the same source
   *  as the top-bar slot (host fetches via `contact.merge.list`). */
  pendingCount: number;
  /** True while a `contact.merge.scan_now` rpc is in flight. The
   *  host flips this on click and clears it on the rpc response
   *  (or the closing `merge_scan_progress` event with `op:
   *  'complete'`). Disables the Scan-now button + shows the
   *  in-flight label. */
  scanning: boolean;
  /** Optional last-scan timestamp (epoch ms). Drives the inline
   *  status line ("Last scan: 5 min ago"). Null suppresses the
   *  line. */
  lastScanAt: number | null;
  /** "now" for the relative timestamp render. The host passes
   *  `Date.now()` on every render. */
  now: number;
  /** True iff the Rejected-pairs management surface is implemented
   *  on this host. P4 ships the entry-point hidden by default; a
   *  future phase flips this to `true` once the rejected-pairs UI
   *  lands. */
  showRejectedPairsLink?: boolean;
  /** Inline error from the most recent Scan-now rpc. Cleared on
   *  next successful scan / click. Surfaced as a small danger
   *  panel when present. */
  error?: string | null;
}

const formatRelative = (ts: number, now: number): string => {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
};

const renderHeader = (state: ContactsSettingsSectionState): string => {
  const n = Math.max(0, Math.floor(state.pendingCount));
  const badge = n > 0
    ? `<span class="contacts-settings-count" aria-label="${e(`${n} pending`)}">${e(n > 99 ? '99+' : String(n))}</span>`
    : '';
  const subtitle = n === 0
    ? 'No pending merge candidates.'
    : `${n} merge candidate${n === 1 ? '' : 's'} pending review.`;
  return `
    <div class="contacts-settings-header">
      <div class="contacts-settings-header-text">
        <strong class="contacts-settings-headline">
          Contact merge queue
          ${badge}
        </strong>
        <span class="contacts-settings-subtitle">${e(subtitle)}</span>
      </div>
    </div>
  `;
};

const renderActions = (state: ContactsSettingsSectionState): string => {
  const buttons: string[] = [];
  if (state.pendingCount > 0) {
    buttons.push(
      button({
        label: 'Open review',
        variant: 'primary',
        size: 'sm',
        action: 'contact-merge-open-review',
      }),
    );
  }
  buttons.push(
    button({
      label: state.scanning ? 'Scanning…' : 'Scan now',
      variant: 'secondary',
      size: 'sm',
      action: 'contact-merge-scan-now',
      disabled: state.scanning,
    }),
  );
  if (state.showRejectedPairsLink === true) {
    buttons.push(
      button({
        label: 'Rejected pairs',
        variant: 'link',
        size: 'sm',
        action: 'contact-merge-open-rejected',
      }),
    );
  }
  return `
    <div class="contacts-settings-actions">
      ${buttons.join('')}
    </div>
  `;
};

const renderStatusLine = (state: ContactsSettingsSectionState): string => {
  if (state.lastScanAt === null) return '';
  const rel = formatRelative(state.lastScanAt, state.now);
  return `<p class="contacts-settings-status">Last scan: ${e(rel)}</p>`;
};

const renderError = (state: ContactsSettingsSectionState): string => {
  if (!state.error) return '';
  return panel({
    tone: 'danger',
    title: 'Scan failed',
    body: e(state.error),
    compact: true,
  });
};

export const renderContactsSettingsSection = (
  state: ContactsSettingsSectionState,
): string => {
  const body = `
    ${renderHeader(state)}
    ${renderActions(state)}
    ${renderStatusLine(state)}
    ${renderError(state)}
  `;
  return section({
    id: 'contacts-merge-settings',
    title: 'Contacts',
    hint: 'Review duplicate contacts surfaced from inline detection + the housekeeping scan. Each item resolves on its own; nothing happens until you confirm.',
    body,
    wrapperClass: 'contacts-settings-section',
  });
};

export const initialContactsSettingsSectionState = (): ContactsSettingsSectionState => ({
  pendingCount: 0,
  scanning: false,
  lastScanAt: null,
  now: Date.now(),
  showRejectedPairsLink: false,
  error: null,
});

export const CONTACTS_SETTINGS_SECTION_STYLES = `
.contacts-settings-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.contacts-settings-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.contacts-settings-header-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.contacts-settings-headline {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.contacts-settings-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-fg, var(--on-accent));
  font-size: 11px;
  font-weight: 600;
}
.contacts-settings-subtitle {
  font-size: 12px;
  color: var(--fg-muted);
}
.contacts-settings-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.contacts-settings-status {
  font-size: 11px;
  color: var(--fg-muted);
  margin: 0;
}
`;
