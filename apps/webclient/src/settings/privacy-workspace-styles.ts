/** Presentation for Settings → Privacy. Shared panels keep their own defaults
 * when mounted elsewhere; consent, loading and confirmation states stay native. */
const PRIVACY = '[data-recued-settings-section="privacy"]';

export const PRIVACY_WORKSPACE_STYLES = `
${PRIVACY} {
  --wc-control-h: 40px;
  min-width: 0;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
${PRIVACY} :where(*) { box-sizing: border-box; min-width: 0; }
${PRIVACY} > h2 {
  margin: 0;
  font-size: 20px;
  line-height: 1.25;
  font-weight: 600;
}
${PRIVACY} .privacy-intro {
  gap: 10px;
  max-width: 76ch;
}
${PRIVACY} .privacy-intro p {
  font-size: 13px;
  line-height: 1.5;
}
${PRIVACY} .privacy-directory {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 10px;
  margin-bottom: 4px;
}
${PRIVACY} .privacy-directory > li {
  display: flex;
  min-width: 0;
}
${PRIVACY} .privacy-directory a {
  box-sizing: border-box;
  width: 100%;
  align-items: flex-start;
  gap: 5px;
  padding: 12px 16px;
  background: var(--surface);
  border-radius: var(--wc-radius-lg, 14px);
}
${PRIVACY} .privacy-directory-title {
  font-size: 13px;
}
${PRIVACY} .privacy-directory-detail {
  font-size: 12px;
  line-height: 1.5;
}
${PRIVACY} > div:not(.privacy-intro) {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 14px);
  background: var(--surface);
}
${PRIVACY} > div > h3 {
  margin: 0 0 16px;
  font-size: 16px;
  line-height: 1.4;
  font-weight: 600;
}
${PRIVACY} :is([data-recued-transparency-panel], [data-recued-learning-panel]) {
  min-width: 0;
  max-width: none;
  gap: 12px;
  font-size: 13px;
}
${PRIVACY} :is(.transparency-row, .learning-row) {
  min-height: 44px;
  padding-block: 4px;
  gap: 10px;
}
${PRIVACY} :is(.transparency-row, .learning-row) input {
  margin: 3px 0 0;
  accent-color: var(--accent);
}
${PRIVACY} :is(.transparency-row-text, .learning-row-text) {
  min-width: 0;
  gap: 4px;
}
${PRIVACY} :is(.transparency-row-detail, .transparency-muted,
  .learning-row-detail, .learning-muted) {
  font-size: 12px;
  line-height: 1.5;
}
${PRIVACY} .transparency-class-group {
  margin-left: 22px;
  padding-left: 12px;
  border-left: 1px solid var(--border);
  gap: 10px;
}
${PRIVACY} .transparency-tier-row {
  display: grid;
  gap: 6px;
  max-width: 30rem;
}
${PRIVACY} .transparency-tier-row > span {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-muted);
}
${PRIVACY} :is(button, select, textarea) {
  box-sizing: border-box;
  min-width: 44px;
  min-height: var(--wc-control-h, 40px);
  max-width: 100%;
  font-size: 13px;
}
${PRIVACY} button {
  padding: 6px 12px;
  border-radius: var(--wc-radius, 9px);
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${PRIVACY} select {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  height: var(--wc-control-h, 40px);
  min-width: 0;
  padding: 6px 10px;
  border-radius: var(--wc-radius, 9px);
  font-weight: 400;
}
${PRIVACY} textarea {
  width: 100%;
  min-height: 112px;
  line-height: 1.5;
}
${PRIVACY} a {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  min-width: 44px;
  min-height: var(--wc-control-h, 40px);
  max-width: 100%;
  color: var(--accent);
  text-underline-offset: 3px;
}
${PRIVACY} :is(a, button, input, select, textarea):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
${PRIVACY} [data-recued-settings-privacy-transparency] > a {
  margin-top: 12px;
  padding-block: 8px;
}
${PRIVACY} :is([data-recued-learning-cases], [data-recued-learning-flows]) {
  display: grid;
  gap: 12px;
}
${PRIVACY} :is([data-recued-learning-cases] > h4, [data-last-time] > h4) {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
${PRIVACY} [data-recued-learning-panel] .learning-case {
  min-width: 0;
  gap: 10px;
  padding: 12px;
  background: var(--bg);
  border-radius: var(--wc-radius, 9px);
}
${PRIVACY} [data-last-time] {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
${PRIVACY} [data-last-time] > :not(button) {
  box-sizing: border-box;
  flex: 0 1 100%;
  min-width: 0;
  margin: 0;
}
${PRIVACY} [data-last-time] button {
  border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius, 6px);
  background: var(--surface);
  color: var(--fg);
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
}
${PRIVACY} [data-last-time] button:hover:not(:disabled) {
  background: var(--surface-sunk);
}
${PRIVACY} [data-last-time] button:disabled {
  opacity: 0.55;
  cursor: default;
}
${PRIVACY} [data-last-time-state] {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 9px);
  background: var(--bg);
}
${PRIVACY} [data-recued-clear-this-browser-panel] {
  gap: 12px;
  padding: 16px;
  border-radius: var(--wc-radius, 9px);
  font-size: 13px;
}
${PRIVACY} .clear-this-browser-title {
  font-size: 14px;
}
${PRIVACY} :is(.clear-this-browser-help, .clear-this-browser-row) {
  font-size: 12px;
}
${PRIVACY} .clear-this-browser-actions {
  flex-wrap: wrap;
}
${PRIVACY} :is(.transparency-row-label, .learning-row-label) { font-weight: 600; }
${PRIVACY} textarea { padding: 10px 12px; border-radius: var(--wc-radius, 9px); }
${PRIVACY} .clear-this-browser-error { font-size: 12px; padding: 12px; border-radius: var(--wc-radius, 9px); }
${PRIVACY} .clear-this-browser-mark { flex: 0 0 1em; }
${PRIVACY} :is([data-last-time-message]:empty, [hidden]) { display: none; }
@media (max-width: 640px) {
  ${PRIVACY} { --wc-control-h: 44px; }
  ${PRIVACY} button { width: 100%; justify-self: stretch; }
  ${PRIVACY} [data-last-time] button { flex: 0 1 100%; }
  ${PRIVACY} .clear-this-browser-actions { width: 100%; }
  ${PRIVACY} [data-recued-clear-this-browser-panel] { padding: 12px; }
  ${PRIVACY} > div:not(.privacy-intro) {
    padding: 12px;
  }
  ${PRIVACY} .transparency-class-group {
    margin-left: 0;
    padding-left: 12px;
  }
  ${PRIVACY} .transparency-tier-row {
    max-width: none;
  }
}
`;
