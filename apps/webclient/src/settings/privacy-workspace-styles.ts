/** Presentation for Settings → Privacy. Shared panels keep their own defaults
 * when mounted elsewhere; consent, loading and confirmation states stay native. */
const PRIVACY = '[data-recued-settings-section="privacy"]';

export const PRIVACY_WORKSPACE_STYLES = `
${PRIVACY} {
  --wc-control-h: 44px;
  min-width: 0;
  gap: 20px;
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
${PRIVACY} > h2 {
  font-size: 22px;
  line-height: 1.25;
  letter-spacing: -0.02em;
}
${PRIVACY} .privacy-intro {
  gap: 10px;
  max-width: 76ch;
}
${PRIVACY} .privacy-intro p {
  font-size: 14px;
  line-height: 1.6;
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
  padding: 14px 16px;
  background: var(--surface);
  border-radius: 10px;
}
${PRIVACY} .privacy-directory-title {
  font-size: 14px;
}
${PRIVACY} .privacy-directory-detail {
  font-size: 13px;
  line-height: 1.5;
}
${PRIVACY} > div:not(.privacy-intro) {
  min-width: 0;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
${PRIVACY} > div > h3 {
  margin: 0 0 16px;
  font-size: 16px;
  line-height: 1.4;
  font-weight: 650;
}
${PRIVACY} :is([data-recued-transparency-panel], [data-recued-learning-panel]) {
  min-width: 0;
  max-width: none;
  gap: 14px;
  font-size: 14px;
}
${PRIVACY} :is(.transparency-row, .learning-row) {
  min-height: 44px;
  padding-block: 4px;
  gap: 10px;
}
${PRIVACY} :is(.transparency-row, .learning-row) input {
  margin-top: 5px;
  accent-color: var(--accent);
}
${PRIVACY} :is(.transparency-row-text, .learning-row-text) {
  min-width: 0;
  gap: 4px;
}
${PRIVACY} :is(.transparency-row-detail, .transparency-muted,
  .learning-row-detail, .learning-muted) {
  font-size: 13px;
  line-height: 1.55;
}
${PRIVACY} .transparency-class-group {
  margin-left: 22px;
  padding-left: 14px;
  border-left: 1px solid var(--border);
  gap: 10px;
}
${PRIVACY} .transparency-tier-row {
  flex-wrap: wrap;
  gap: 8px 12px;
}
${PRIVACY} :is(button, select, textarea) {
  box-sizing: border-box;
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  font-size: 14px;
}
${PRIVACY} button {
  padding: 10px 14px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${PRIVACY} select {
  height: 44px;
  min-width: 0;
  padding: 8px 10px;
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
  min-height: 44px;
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
${PRIVACY} [data-recued-learning-cases] {
  display: grid;
  gap: 12px;
}
${PRIVACY} :is([data-recued-learning-cases] > h4, [data-last-time] > h4) {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
${PRIVACY} [data-recued-learning-panel] .learning-case {
  min-width: 0;
  gap: 10px;
  padding: 14px;
  background: var(--bg);
  border-radius: 8px;
}
${PRIVACY} [data-last-time] {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px;
  margin-top: 20px;
  padding-top: 20px;
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
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}
${PRIVACY} [data-recued-clear-this-browser-panel] {
  gap: 12px;
  padding: 16px;
  border-radius: 8px;
  font-size: 14px;
}
${PRIVACY} .clear-this-browser-title {
  font-size: 15px;
}
${PRIVACY} :is(.clear-this-browser-help, .clear-this-browser-row) {
  font-size: 13px;
}
${PRIVACY} .clear-this-browser-actions {
  flex-wrap: wrap;
}
@media (max-width: 600px) {
  ${PRIVACY} > div:not(.privacy-intro) {
    padding: 16px;
  }
  ${PRIVACY} .transparency-class-group {
    margin-left: 0;
    padding-left: 12px;
  }
  ${PRIVACY} .transparency-tier-row {
    align-items: stretch;
    flex-direction: column;
  }
}
`;
