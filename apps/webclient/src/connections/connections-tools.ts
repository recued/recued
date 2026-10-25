/** Connections → the secondary surfaces under a lane: the "Advanced" group of
 *  collapsible tool cards (saved OAuth apps, managed sign-in, bulk migration,
 *  connection replacement, Personal or work), plus one typography + control
 *  layer for the authentication sub-panels mounted inside them.
 *
 *  Several of those sub-panels render bare `h2`/`p`/`select`/`button` with only
 *  a few layout rules of their own, so without a shared layer they fell back to
 *  browser defaults (24px headings, 16px body, grey system buttons) beside the
 *  13px cards around them. The layer sits inside `:where()`, so any rule a
 *  panel does set — e.g. the polished broker panel nested in the migration
 *  panel — still wins; it fills in what a panel leaves unset.
 *
 *  Built with createElement / appendChild / setAttribute / textContent only:
 *  the route's unit tests mount it on a string-only fake DOM. */

export const CONNECTIONS_ADVANCED_ATTR = 'data-recued-connections-advanced';
export const CONNECTIONS_TOOL_ATTR = 'data-recued-connections-tool';

export interface ConnectionsToolCard {
  /** The `<details>` card. */
  root: HTMLElement & { open?: boolean };
  /** Where the tool's own panel mounts. */
  body: HTMLElement;
}

/** One collapsible tool: a title and a one-line description in the summary,
 *  the tool itself in the body. Closed by default. */
export const createConnectionsToolCard = (doc: Document, tool: {
  id: string; title: string; description: string;
}): ConnectionsToolCard => {
  const root = doc.createElement('details') as HTMLElement & { open?: boolean };
  root.className = 'connections-tool';
  root.setAttribute(CONNECTIONS_TOOL_ATTR, tool.id);
  const summary = doc.createElement('summary');
  summary.className = 'connections-tool-summary';
  const heading = doc.createElement('span');
  heading.className = 'connections-tool-heading';
  const title = doc.createElement('span');
  title.className = 'connections-tool-title';
  title.textContent = tool.title;
  const description = doc.createElement('span');
  description.className = 'connections-tool-desc';
  description.textContent = tool.description;
  heading.appendChild(title);
  heading.appendChild(description);
  const chevron = doc.createElement('span');
  chevron.className = 'connections-tool-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  summary.appendChild(heading);
  summary.appendChild(chevron);
  const body = doc.createElement('div');
  body.className = 'connections-tool-body';
  root.appendChild(summary);
  root.appendChild(body);
  return { root, body };
};

/** The "Advanced" heading and the list its tool cards go into. */
export const createConnectionsAdvancedSection = (doc: Document, copy: {
  title: string; description: string;
}): { root: HTMLElement; list: HTMLElement } => {
  const root = doc.createElement('section');
  root.className = 'connections-advanced';
  root.setAttribute(CONNECTIONS_ADVANCED_ATTR, '');
  root.setAttribute('aria-labelledby', 'connections-advanced-title');
  const header = doc.createElement('div');
  header.className = 'connections-advanced-header';
  const title = doc.createElement('h2');
  title.className = 'connections-advanced-title';
  title.id = 'connections-advanced-title';
  title.textContent = copy.title;
  const description = doc.createElement('p');
  description.className = 'connections-advanced-desc';
  description.textContent = copy.description;
  header.appendChild(title);
  header.appendChild(description);
  const list = doc.createElement('div');
  list.className = 'connections-advanced-list';
  root.appendChild(header);
  root.appendChild(list);
  return { root, list };
};

/** Sub-panels that bring no typography of their own. */
const TOOL_PANELS = [
  '.connections-tool-body',
  '.oauth-apps',
  '.connections-bulk-migration',
  '.accounts-bulk-app-switch',
  '.accounts-authentication-review',
  '.accounts-oauth-app-switch',
  '.accounts-password-repair',
].join(', ');

export const connectionsToolsStyles = (scope: string): string => `
${scope} .connections-advanced { display: grid; gap: 10px; min-width: 0; margin-top: 32px; }
/* Adding a connection is the page's one job: the tools for existing ones step back. */
${scope}:has(.connections-dialog[data-dialog-mode="create"]) .connections-advanced { display: none; }
${scope} :is(.connections-advanced, .connections-tool)[hidden],
${scope} .connections-tool-body [hidden] { display: none !important; }
${scope} .connections-advanced-header { display: grid; gap: 3px; min-width: 0; margin-bottom: 2px; }
${scope} .connections-advanced-title {
  margin: 0; color: var(--fg-strong, var(--fg));
  font-size: 16px; line-height: 1.3; font-weight: 680;
}
${scope} .connections-advanced-desc { margin: 0; color: var(--fg-muted); font-size: 13px; line-height: 1.5; }
${scope} .connections-advanced-list { display: grid; gap: 8px; min-width: 0; }
${scope} .connections-tool {
  display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
}
${scope} .connections-tool > summary {
  list-style: none; display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 14px; min-width: 0; padding: 13px 16px;
  border-radius: 10px; cursor: pointer;
}
${scope} .connections-tool > summary::-webkit-details-marker { display: none; }
${scope} .connections-tool > summary:hover { background: var(--surface-sunk); }
${scope} .connections-tool > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
${scope} .connections-tool[open] > summary { border-bottom: 1px solid var(--border); border-radius: 10px 10px 0 0; }
${scope} .connections-tool-heading { display: grid; gap: 2px; min-width: 0; }
${scope} .connections-tool-title {
  overflow-wrap: anywhere; color: var(--fg-strong, var(--fg));
  font-size: 14px; line-height: 1.35; font-weight: 650;
}
${scope} .connections-tool-desc { overflow-wrap: anywhere; color: var(--fg-muted); font-size: 12.5px; line-height: 1.45; }
${scope} .connections-tool-chevron {
  width: 7px; height: 7px; margin: 0 4px 4px 0;
  border-right: 2px solid var(--fg-muted); border-bottom: 2px solid var(--fg-muted);
  transform: rotate(45deg); transition: transform 120ms ease;
}
${scope} .connections-tool[open] > summary .connections-tool-chevron { margin-bottom: -2px; transform: rotate(-135deg); }
${scope} .connections-tool-body { min-width: 0; padding: 14px 16px 16px; overflow-wrap: anywhere; }
${scope} .connections-tool-body > :first-child { margin-top: 0; }
${scope} .connections-tool-body > :last-child { margin-bottom: 0; }
${scope} .connections-tool-body .oauth-apps,
${scope} .connections-tool-body .connections-bulk-migration { margin: 0; padding: 0; border: 0; max-width: none; }
${scope} .connections-tool-body .oauth-apps > h2,
${scope} .connections-tool-body .oauth-apps > h2 + p,
${scope} .connections-tool-body .connections-bulk-migration > h2,
${scope} .connections-tool-body .connections-bulk-migration > h2 + p { display: none; }
${scope} .connections-tool-body .connections-broker-manager {
  display: grid; gap: 12px; margin: 0; padding: 0; border: 0; background: none; max-width: none;
}
${scope} .connections-tool-body .connections-broker-manager > .rx-btn { justify-self: start; min-height: 36px; }
${scope} .connections-tool-body .connections-broker-manager-intro p { font-size: 13px; }
${scope} .connections-tool-note { margin: 0 0 12px; color: var(--fg-muted); font-size: 13px; line-height: 1.5; }
${scope} .connections-tool-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

:where(${scope} :is(${TOOL_PANELS})) { font-size: 13px; line-height: 1.5; color: var(--fg); }
:where(${scope} :is(${TOOL_PANELS})) h2 {
  margin: 0 0 6px; color: var(--fg-strong, var(--fg));
  font-size: 16px; line-height: 1.3; font-weight: 680;
}
:where(${scope} :is(${TOOL_PANELS})) h3 {
  margin: 16px 0 6px; color: var(--fg-strong, var(--fg));
  font-size: 14px; line-height: 1.35; font-weight: 650;
}
:where(${scope} :is(${TOOL_PANELS})) :is(h4, h5) {
  margin: 12px 0 4px; color: var(--fg-strong, var(--fg));
  font-size: 13px; line-height: 1.4; font-weight: 650;
}
:where(${scope} :is(${TOOL_PANELS})) :is(h2, h3, h4, h5):first-child { margin-top: 0; }
:where(${scope} :is(${TOOL_PANELS})) p { margin: 6px 0; }
:where(${scope} :is(${TOOL_PANELS})) ul { margin: 6px 0; padding-left: 18px; }
:where(${scope} :is(${TOOL_PANELS})) li { margin: 4px 0; }
:where(${scope} :is(${TOOL_PANELS})) label { font-size: 13px; }
:where(${scope} :is(${TOOL_PANELS})) :is(select, textarea, input:not([type=checkbox]):not([type=radio])) {
  box-sizing: border-box; max-width: 100%; min-height: 36px; padding: 7px 10px;
  font: inherit; font-size: 13px; color: var(--fg); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: 7px;
}
:where(${scope} :is(${TOOL_PANELS})) :is(select, textarea, input):focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
:where(${scope} :is(${TOOL_PANELS})) button:not(.rx-btn) {
  display: inline-flex; align-items: center; justify-content: center; max-width: 100%;
  min-height: 34px; margin: 4px 8px 4px 0; padding: 6px 12px;
  font: inherit; font-size: 12.5px; font-weight: 600; line-height: 1.25; text-align: center; white-space: normal;
  color: var(--fg); background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px; cursor: pointer;
}
:where(${scope} :is(${TOOL_PANELS})) button:not(.rx-btn):hover:not(:disabled) { background: var(--surface-sunk); }
:where(${scope} :is(${TOOL_PANELS})) button:not(.rx-btn):disabled { opacity: 0.5; cursor: default; }
:where(${scope} :is(${TOOL_PANELS})) button:not(.rx-btn):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
:where(${scope} :is(${TOOL_PANELS})) a { color: var(--accent); font-weight: 600; text-decoration: none; }
:where(${scope} :is(${TOOL_PANELS})) a:hover { text-decoration: underline; }
:where(${scope} :is(${TOOL_PANELS})) [role=alert] { color: var(--danger); }
:where(${scope} :is(${TOOL_PANELS})) code {
  padding: 1px 5px; border-radius: 4px; background: var(--surface-sunk);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px;
}
:where(${scope} :is(${TOOL_PANELS})) details > summary { cursor: pointer; font-weight: 600; }
`;
