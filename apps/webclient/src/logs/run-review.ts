import {
  normalizeShellHash, parseLogsRunAddress, parseShellRoute, runReviewWorkspaceHref,
  serializeLogsRunAddress, type LogsRunAddress,
} from '../shell/route.js';

export const RUN_REVIEW_LABEL = 'Review run';
export const RUN_REVIEW_LINK_ATTR = 'data-recued-run-review-link';

/** An exact recorded anchor is required. A recipe, prior result, or approval
 * ID cannot substitute for it. This helper constructs navigation only. */
export const runReviewHref = (
  runId: string | undefined,
  context: Omit<LogsRunAddress, 'runId'> = {},
): string | null => {
  if (typeof runId !== 'string' || runId.trim().length === 0) return null;
  const address = parseLogsRunAddress({ surface: 'logs', segments: [runId] });
  return address === null ? null : serializeLogsRunAddress({ ...context, ...address });
};

/** Returning to a workspace must leave keyboard users in that view. Wait for
 * its existing read boundary; another navigation or user gesture retires the
 * focus request. A route that already restored focus keeps ownership. */
export const focusRunReviewReturn = (opts: {
  document: Document;
  root: HTMLElement;
  fromHash: string;
  toHash: string;
  whenLoaded?: () => Promise<void>;
  isCurrent: () => boolean;
}): (() => void) => {
  const workspace = parseLogsRunAddress(parseShellRoute(opts.fromHash))?.returnToWorkspace;
  if (workspace === undefined || runReviewWorkspaceHref(workspace) !== normalizeShellHash(opts.toHash)) {
    return () => {};
  }
  const doc = opts.document;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    doc.removeEventListener('pointerdown', cancel, true);
    doc.removeEventListener('keydown', cancel, true);
  };
  doc.addEventListener('pointerdown', cancel, { capture: true, once: true });
  doc.addEventListener('keydown', cancel, { capture: true, once: true });
  void (async (): Promise<void> => {
    try {
      try { await opts.whenLoaded?.(); } catch { /* The route may show a read error. */ }
      if (cancelled || !opts.isCurrent()) return;
      const active = doc.activeElement;
      if (active && active !== doc.body && active.isConnected) return;
      const target = (workspace.surface === 'recipes'
        ? opts.root.querySelector<HTMLElement>('[data-recued-recipes-detail-heading]') : null)
        ?? opts.root.querySelector<HTMLElement>('h1, h2, [role="heading"]');
      target?.setAttribute('tabindex', '-1');
      target?.focus();
    } finally { cancel(); }
  })();
  return cancel;
};
