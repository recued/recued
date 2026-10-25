export const AUTOMATION_REHEARSAL_STYLES = `
[data-automation-rehearsal] {
  --wc-control-h: 44px;
  display: grid;
  gap: 16px;
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  color: var(--fg);
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[data-automation-rehearsal] :where(*) { box-sizing: border-box; min-width: 0; max-width: 100%; }
[data-automation-rehearsal] [hidden] { display: none !important; }
[data-automation-rehearsal] :is(h3, h4, h5, p, dl) { margin: 0; }
[data-automation-rehearsal] h3 { font-size: 20px; line-height: 1.35; }
[data-automation-rehearsal] h4 { font-size: 16px; line-height: 1.4; }
[data-automation-rehearsal] h5 { font-size: 14px; line-height: 1.4; }
[data-automation-rehearsal] .rehearsal-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
[data-automation-rehearsal] .rehearsal-header > div { flex: 1 1 280px; display: grid; gap: 6px; }
[data-automation-rehearsal] :is(.rehearsal-hint, .rehearsal-field > span) { color: var(--muted); font-size: 12px; }
[data-automation-rehearsal] :is(.rehearsal-card, .rehearsal-progress) {
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 10px);
  background: var(--surface);
}
[data-automation-rehearsal] .rehearsal-card {
  display: grid;
  align-content: start;
  gap: 14px;
  padding: clamp(14px, 2vw, 20px);
}
[data-automation-rehearsal] .rehearsal-progress { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
[data-automation-rehearsal] .rehearsal-progress > div { display: grid; align-content: start; gap: 4px; padding: 12px; }
[data-automation-rehearsal] .rehearsal-progress > div + div { border-inline-start: 1px solid var(--border); }
[data-automation-rehearsal] .rehearsal-progress dt { color: var(--muted); font-size: 12px; }
[data-automation-rehearsal] .rehearsal-progress dd { margin: 0; font-weight: 650; font-size: 13px; }
[data-automation-rehearsal] [data-rehearsal-tone="attention"] { color: var(--danger); }
[data-automation-rehearsal] [data-rehearsal-tone="ready"] { color: var(--accent); }
[data-automation-rehearsal] .rehearsal-feedback { display: grid; gap: 8px; }
[data-automation-rehearsal] .rehearsal-feedback p:not(:empty) { padding: 10px 12px; border-left: 3px solid var(--accent); background: var(--surface-subtle); }
[data-automation-rehearsal] .rehearsal-feedback [role="alert"]:not(:empty) { border-left-color: var(--danger); color: var(--danger); }
[data-automation-rehearsal] .rehearsal-edit-grid,
[data-automation-rehearsal] .rehearsal-comparison-grid { display: grid; gap: 16px; align-items: start; }
[data-automation-rehearsal] .rehearsal-edit-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); }
[data-automation-rehearsal] .rehearsal-comparison-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); }
[data-automation-rehearsal] .rehearsal-comparison-grid > div { display: grid; gap: 10px; }
[data-automation-rehearsal] .rehearsal-field { display: grid; gap: 6px; margin: 0; }
[data-automation-rehearsal] :is(input:not([type="checkbox"]), textarea, select) {
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: var(--wc-radius, 6px);
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
}
/* WebKit can paint long option text beyond a narrow native popup select. */
[data-automation-rehearsal] select { height: 44px; overflow: hidden; text-overflow: ellipsis; }
[data-automation-rehearsal] textarea { resize: vertical; line-height: 1.5; }
[data-automation-rehearsal] .rehearsal-checkbox { display: flex; align-items: center; gap: 10px; min-height: 44px; }
[data-automation-rehearsal] input[type="checkbox"] { flex: 0 0 auto; width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
[data-automation-rehearsal].rehearsal-workspace button.automation-button {
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--border-strong, var(--border));
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
[data-automation-rehearsal].rehearsal-workspace button.automation-button:hover:not(:disabled) { background: var(--accent-weak); }
[data-automation-rehearsal].rehearsal-workspace button.automation-button--primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
[data-automation-rehearsal].rehearsal-workspace button.automation-button--danger { border-color: var(--danger); color: var(--danger); }
[data-automation-rehearsal].rehearsal-workspace button.automation-button--primary:hover:not(:disabled) { background: var(--accent); }
[data-automation-rehearsal].rehearsal-workspace button.automation-button--danger:hover:not(:disabled) { background: var(--danger-weak); }
[data-automation-rehearsal] button:disabled { cursor: not-allowed; opacity: .6; }
[data-automation-rehearsal] :is(button, input, select, textarea, summary, [tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[data-automation-rehearsal] .rehearsal-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
[data-automation-rehearsal] :is(.rehearsal-scenarios, .rehearsal-results) { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
[data-automation-rehearsal] :is(.rehearsal-scenarios > li, .rehearsal-results > li, .rehearsal-history-entry) {
  display: grid;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 6px);
  background: var(--surface-subtle);
}
[data-automation-rehearsal] .rehearsal-results > li { border-left: 3px solid var(--accent); }
[data-automation-rehearsal] .rehearsal-results > li[data-passed="false"] { border-left-color: var(--danger); }
[data-automation-rehearsal] .rehearsal-disclosure { border-top: 1px solid var(--border); padding-top: 6px; }
[data-automation-rehearsal] details.rehearsal-card { display: block; }
[data-automation-rehearsal] .rehearsal-history-list { display: grid; gap: 12px; padding-top: 12px; }
[data-automation-rehearsal] summary { min-height: 44px; padding: 10px 0; font-weight: 600; cursor: pointer; }
[data-automation-rehearsal] .rehearsal-scenario-form { display: grid; gap: 12px; padding-top: 10px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); }
[data-automation-rehearsal] .rehearsal-scenario-form > :is(.rehearsal-field-wide, .rehearsal-checkbox, .rehearsal-actions) { grid-column: 1 / -1; }
[data-automation-rehearsal] .rehearsal-version-picker { display: grid; gap: 10px; padding-top: 14px; border-top: 1px solid var(--border); }
[data-automation-rehearsal] .rehearsal-version-picker > button { justify-self: start; }
[data-automation-rehearsal] pre { margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 6px); background: var(--surface-subtle); color: var(--fg); font: 12px/1.6 var(--mono, ui-monospace, monospace); white-space: pre-wrap; overflow-wrap: anywhere; }
[data-automation-rehearsal] .rehearsal-cleanup { border-top: 3px solid var(--border-strong, var(--border)); }
[data-automation-rehearsal] .rehearsal-cleanup > .rehearsal-actions { padding-top: 6px; }
@media (max-width: 360px) {
  [data-automation-rehearsal] .rehearsal-progress { grid-template-columns: minmax(0, 1fr); }
  [data-automation-rehearsal] .rehearsal-progress > div { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 10px; }
  [data-automation-rehearsal] .rehearsal-progress > div + div { border-inline-start: 0; border-top: 1px solid var(--border); }
}
`;
