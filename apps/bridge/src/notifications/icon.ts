/** The Bridge's default OS-notification icon, bundled with the extension. The dispatcher and the
 *  approval notices pass it to `chrome.notifications` when a notification names none; the
 *  service worker resolves it against the extension's root (`chrome.runtime.getURL`).
 *
 *  ⛔ A raster image. It was `icons/logo.svg`, and Chrome refuses an SVG here ("Unable to download
 *  all specified images."), so every notification the Bridge raised failed: its reminders' too.
 *  Found driving a live Bridge (2026-11-03, `scripts/drives/bridge-approval-notice.mjs`); the
 *  unit tests' fakes accept any icon. */
export const DEFAULT_NOTIFICATION_ICON_PATH = 'icons/logo-128.png' as const;
