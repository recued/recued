/** Settings → Updates presentation. The page retains its connected controls,
 * pending-state ownership, update gates and recovery lifecycle. */
const updates = '[data-recued-settings-section="updates"]';

export const UPDATES_WORKSPACE_STYLES = `
${updates} {
  --wc-control-h: 40px;
  min-width: 0;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
${updates} :where(*) { box-sizing: border-box; min-width: 0; }
${updates} > h2 { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; }
${updates} [data-recued-updates-page] { gap: 16px; }
${updates} :is(.updates-version-card, .updates-policy-card, .updates-recovery-card) {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 14px);
  background: var(--surface);
}
${updates} :is(.updates-version-card, .updates-policy-card, .updates-recovery-card) > h3 {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
  font-weight: 600;
}
${updates} :is(.updates-version-card, .updates-policy-card, .updates-recovery-card) > p {
  margin: 0;
  line-height: 1.5;
}
${updates} [data-recued-updates-version] { font-weight: 600; }
${updates} :is([data-recued-updates-webapp-version], [data-recued-updates-mode-note]) {
  color: var(--fg-muted);
  font-size: 12px;
}
${updates} [data-recued-updates-status]:empty { display: none; }
${updates} [data-recued-updates-error] { color: var(--fail); }
${updates} :is(button, a) {
  min-width: 0;
  min-height: var(--wc-control-h, 40px);
  max-width: 100%;
  padding: 6px 12px;
  border-radius: var(--wc-radius, 9px);
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${updates} button { justify-self: start; }
${updates} a {
  display: inline-flex;
  align-items: center;
  padding-inline: 0;
  color: var(--accent);
  text-underline-offset: 3px;
}
${updates} :is(button, a, select):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
${updates} .updates-policy-card > label {
  display: grid;
  gap: 6px;
  max-width: 30rem;
  color: var(--fg-muted);
  font-size: 12px;
  font-weight: 600;
}
${updates} [data-recued-updates-mode] {
  width: 100%;
  max-width: 30rem;
  min-width: 0;
  height: var(--wc-control-h, 40px);
  min-height: var(--wc-control-h, 40px);
  padding: 6px 10px;
  border-radius: var(--wc-radius, 9px);
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
}
${updates} [data-recued-updates-available] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--wc-radius-lg, 14px);
  background: var(--surface);
}
${updates} [data-recued-updates-available] > :is(p, code) {
  flex: 0 1 100%;
  margin: 0;
  max-width: 100%;
}
${updates} [data-recued-updates-available] > p:first-child {
  font-size: 16px;
  font-weight: 600;
}
${updates} [data-recued-updates-available]:has([data-recued-updates-apply-confirm]) > a {
  flex-basis: 100%;
}
${updates} [data-update-docker-pull-ref] {
  padding: 10px 12px;
  border-radius: var(--wc-radius, 9px);
  background: var(--bg);
  font-size: 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
${updates} [data-recued-updates-apply-result] {
  margin: 0;
  padding: 12px;
  border-left: 3px solid var(--accent);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface-sunk);
  line-height: 1.5;
}
${updates} :is([data-recued-updates-credential-retry],
  [data-recued-updates-tab-progress], [data-recued-updates-receipt-recovery]) {
  gap: 12px;
  padding: 16px;
  border-radius: var(--wc-radius-lg, 14px);
  font-size: 13px;
  line-height: 1.5;
}
${updates} :is([data-recued-updates-credential-retry], [data-recued-updates-receipt-recovery]) > h3 {
  margin: 0;
  font-size: 16px;
}
${updates} :is([data-recued-updates-tab-progress], [data-recued-updates-receipt-recovery]) > strong {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}
${updates} :is(.updates-credential-retry-privacy,
  [data-recued-updates-tab-progress-privacy], [data-recued-updates-receipt-recovery] pre) {
  font-size: 12px;
  line-height: 1.5;
}
${updates} [data-recued-updates-receipt-recovery] pre { white-space: pre-wrap; overflow-wrap: anywhere; }
${updates} :is([data-recued-updates-receipt-closure-review], [data-recued-updates-receipt-baseline]) { gap: 8px; padding: 12px; border-radius: var(--wc-radius, 9px); }
/* A card's layout must not expose recovery or policy states that are hidden. */
${updates} [hidden] { display: none; }
@media (max-width: 640px) {
  ${updates} { --wc-control-h: 44px; }
  ${updates} button { width: 100%; justify-self: stretch; }
  ${updates} :is(.updates-version-card, .updates-policy-card, .updates-recovery-card,
    [data-recued-updates-available], [data-recued-updates-credential-retry],
    [data-recued-updates-tab-progress], [data-recued-updates-receipt-recovery]) { padding: 12px; }
}
`;
