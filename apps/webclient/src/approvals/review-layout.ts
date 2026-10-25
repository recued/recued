import { serializeShellRoute } from '../shell/route.js';

export const APPROVAL_VIEW_NAV_STYLES = `
.approval-view-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  box-sizing: border-box;
  width: fit-content;
  max-width: 100%;
  margin: 0 0 16px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 10px);
  background: var(--surface-subtle);
}
.approval-view-nav a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 0;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: var(--wc-radius, 6px);
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  text-decoration: none;
}
.approval-view-nav a[aria-current="page"] {
  border-color: var(--border);
  background: var(--surface);
  color: var(--fg);
}
.approval-view-nav a:hover {
  background: var(--accent-weak);
  color: var(--accent);
}
.approval-view-nav a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 600px) {
  .approval-view-nav {
    display: grid;
    width: 100%;
    grid-template-columns: minmax(68px, .75fr) minmax(0, 1.3fr) minmax(0, 1.1fr);
  }
  .approval-view-nav a {
    padding: 6px 4px;
  }
}
`;

type ApprovalView = 'pending' | 'runs' | 'changes';

export const createApprovalViewNav = (
  doc: Document,
  active: ApprovalView,
): HTMLElement => {
  const nav = doc.createElement('nav');
  nav.className = 'approval-view-nav';
  nav.setAttribute('aria-label', 'Approval views');
  for (const [view, label, href] of [
    ['pending', 'Pending', serializeShellRoute('approvals')],
    ['runs', 'Runs you have looked at', serializeShellRoute('approvals', 'preapproval')],
    ['changes', 'Atomic local changes', serializeShellRoute('approvals', 'local-changes')],
  ] as const) {
    const link = doc.createElement('a');
    link.href = href;
    link.textContent = label;
    if (view === active) link.setAttribute('aria-current', 'page');
    nav.append(link);
  }
  return nav;
};

const REVIEW_STYLES = `${APPROVAL_VIEW_NAV_STYLES}
[data-recued-approval-review] {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 16px;
  color: var(--fg);
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[data-recued-approval-review] > * { min-width: 0; max-width: 100%; }
[data-recued-approval-review] :where(a) {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  min-height: 44px;
  max-width: 100%;
  padding: 6px 8px;
  border-radius: var(--wc-radius, 6px);
  color: var(--accent);
  font-size: 13px;
  text-decoration: none;
  overflow-wrap: anywhere;
}
[data-recued-approval-review] :where(a):hover { background: var(--accent-weak); }
[data-recued-approval-review] :is(a, button, input, pre):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
[data-recued-approval-review] .approval-review-back { margin-bottom: 8px; }
[data-recued-approval-review] .approval-review-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
[data-recued-approval-review] h1 {
  flex: 1 1 240px;
  min-width: 0;
  margin: 0;
  font-size: 24px;
  line-height: 1.3;
}
[data-recued-approval-review] h2 {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
}
[data-recued-approval-review] p { margin: 0; }
[data-recued-approval-review] button {
  box-sizing: border-box;
  min-height: 44px;
  max-width: 100%;
}
[data-recued-approval-review] .approval-review-button {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 6px);
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
  cursor: pointer;
}
[data-recued-approval-review] .approval-review-button-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
[data-recued-approval-review] button:disabled { opacity: .6; cursor: not-allowed; }
[data-recued-approval-review] :is(.approval-review-summary, .approval-review-member, .approval-review-actions) {
  box-sizing: border-box;
  min-width: 0;
  padding: clamp(14px, 2vw, 22px);
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 10px);
  background: var(--surface);
}
[data-recued-approval-review] :is(.approval-review-summary, .approval-review-content, .approval-review-member) {
  display: grid;
  align-content: start;
  gap: 12px;
}
[data-recued-approval-review] :is(.approval-review-summary, .approval-review-content) { margin-bottom: 16px; }
[data-recued-approval-review] .approval-review-summary > .approval-review-button { justify-self: start; }
[data-recued-approval-review] .approval-review-content { min-width: 0; }
[data-recued-approval-review] .approval-review-member > * { min-width: 0; max-width: 100%; }
[data-recued-approval-review] .approval-review-member-child { margin-left: 12px; }
[data-recued-approval-review] .approval-review-member > label {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  font-weight: 650;
}
[data-recued-approval-review] input[type="checkbox"] {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin: 0;
  accent-color: var(--accent);
}
[data-recued-approval-review] input:not([type="checkbox"]) {
  box-sizing: border-box;
  min-width: 0;
  min-height: 44px;
  max-width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 6px);
  background: var(--surface);
  color: var(--fg);
}
[data-recued-approval-review] pre {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 6px);
  background: var(--surface-subtle);
  color: var(--fg);
  font: 12px/1.6 var(--mono, ui-monospace, monospace);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
[data-recued-approval-review] .approval-review-summary > [role="status"] {
  padding-left: 10px;
  border-left: 3px solid var(--accent);
  font-weight: 650;
}
[data-recued-approval-review] .approval-review-summary > :is([data-review-status="unknown"], [data-review-status="failed"], [data-review-status="in_doubt"], [data-review-status="expired"]) {
  border-left-color: var(--danger);
}
[data-recued-approval-review] [role="alert"] { color: var(--danger); }
[data-recued-approval-review] .approval-review-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[data-recued-approval-review] .approval-review-actions > p { flex-basis: 100%; }
[data-recued-approval-review] :is(.approval-review-summary, .approval-review-content, .approval-review-actions):empty { display: none; }
[data-recued-approval-review] .approval-review-list {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-recued-approval-review] .approval-review-list > li {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 10px);
  background: var(--surface);
}
[data-recued-approval-review] .approval-review-list > li > p { margin-top: 6px; color: var(--muted); font-size: 13px; }
`;

/** Presentation only: callers retain the existing reads, decision callbacks,
 * request identities and focus restoration, and fill these containers in order. */
export const createApprovalReviewLayout = (
  doc: Document,
  host: HTMLElement,
  options: { title: string; view: 'runs' | 'changes'; refresh: HTMLButtonElement },
): { summary: HTMLElement; content: HTMLElement; actions: HTMLElement } => {
  if (doc.head && !doc.head.querySelector('[data-recued-approval-review-styles]')) {
    const style = doc.createElement('style');
    style.setAttribute('data-recued-approval-review-styles', '');
    style.textContent = REVIEW_STYLES;
    doc.head.append(style);
  }
  host.setAttribute('data-recued-approval-review', '');
  const back = doc.createElement('a');
  back.className = 'approval-review-back';
  back.href = serializeShellRoute('approvals');
  back.textContent = 'Approvals';
  const header = doc.createElement('header');
  header.className = 'approval-review-header';
  const heading = doc.createElement('h1');
  heading.tabIndex = -1;
  heading.textContent = options.title;
  header.append(heading, options.refresh);
  const summary = doc.createElement('div'); summary.className = 'approval-review-summary';
  const content = doc.createElement('div'); content.className = 'approval-review-content';
  const actions = doc.createElement('div'); actions.className = 'approval-review-actions';
  host.append(back, header, createApprovalViewNav(doc, options.view), summary, content, actions);
  return { summary, content, actions };
};
