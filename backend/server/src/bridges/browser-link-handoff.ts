import type { OutlineControl } from './page-outline.js';

export interface BrowserLinkTransition { before_url: string; after_url: string }
export type BrowserLookupRecovery =
  | { kind?: 'link'; before_url: string; recovered: (guard: BrowserLinkTransition) => void }
  | { kind: 'field'; before_url?: string };

/** A pending read may be compared with a fresh read, never used to click by
 * itself. Forms, same-URL/fragment controls and cross-origin transitions do not
 * enter this recovery path. No action is retried. */
export const linkTransition = (control: OutlineControl, before: string): BrowserLinkTransition | undefined => {
  if (control.kind !== 'link' || !control.href || before.length > 2_048 || control.href.length > 2_048) return undefined;
  try {
    const from = new URL(before), to = new URL(control.href);
    // ⚠ A bare `#` (`href="#"`, a script's link such as a table's page numbers) parses with an empty `hash`,
    //   so the hash alone let it through as a navigation to `…#`, which a click never reaches (task M, 2026-11-20).
    if (!['http:', 'https:'].includes(from.protocol) || from.origin !== to.origin || from.hash || to.hash
      || before.includes('#') || control.href.includes('#')
      || from.username || from.password || to.username || to.password || from.href === to.href) return undefined;
    return { before_url: before, after_url: control.href };
  } catch { return undefined; }
};

export const sameReadControl = (before: OutlineControl, after: OutlineControl): boolean => before.ref === after.ref
  && before.kind === after.kind && before.field === after.field && before.href === after.href
  && JSON.stringify(before.names) === JSON.stringify(after.names);
