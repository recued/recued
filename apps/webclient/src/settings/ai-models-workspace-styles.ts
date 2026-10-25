const workspace = '[data-recued-ai-models-page].ai-models-page:has(.ai-models-tabs)';

export const AI_MODELS_WORKSPACE_STYLES = `
${workspace} {
  --wc-control-h: 44px;
  gap: 16px;
  min-width: 0;
  max-width: 100%;
  color: var(--fg);
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
${workspace} :where(*) { box-sizing: border-box; min-width: 0; max-width: 100%; }
${workspace} [hidden] { display: none !important; }
${workspace} .ai-models-tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; margin: 0; padding: 4px; border: 1px solid var(--border); border-radius: var(--wc-radius-lg, 10px); background: var(--surface-subtle); }
${workspace} button.ai-models-tab { min-height: 44px; margin: 0; padding: 8px 10px; border: 1px solid transparent; border-radius: var(--wc-radius, 6px); font-size: 13px; white-space: normal; }
${workspace} button.ai-models-tab[data-active="true"] { border-color: var(--border); background: var(--surface); color: var(--fg); }
${workspace} .ai-models-tabpanel { gap: 16px; }
${workspace} .ai-models-tabpanel[data-active="false"] { display: none; }
${workspace} .ai-models-tabpanel > section,
${workspace} .ai-models-tabpanel > .ai-models-slot {
  display: grid;
  align-content: start;
  gap: 14px;
  padding: clamp(14px, 2vw, 20px);
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 10px);
  background: var(--surface);
}
${workspace} h3 { margin: 0; font-size: 16px; line-height: 1.4; }
${workspace} h4 { margin: 0; font-size: 14px; line-height: 1.4; }
${workspace} :is(.ai-models-slot, .ai-models-pool-row, .ai-models-add-pool) { display: grid; align-content: start; gap: 12px; padding: 14px; border: 1px solid var(--border); border-radius: var(--wc-radius, 6px); background: var(--surface-subtle); }
${workspace} .ai-models-slot > span { color: var(--fg-muted); font-size: 13px; }
${workspace} .ai-models-pool-row > span { font-weight: 600; }
${workspace} .ai-models-add-pool h4 { margin: 0; }
${workspace} .ai-models-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 14px 16px; align-items: start; }
${workspace} .ai-models-field { gap: 6px; margin: 0; font-size: 13px; }
${workspace} :is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]), select, textarea) { width: 100%; max-width: 100%; min-height: 44px; padding: 10px 12px; font: inherit; font-size: 13px; }
${workspace} select { height: 44px; overflow: hidden; text-overflow: ellipsis; }
${workspace} button:where(:not(.ai-models-tab)) { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; margin: 0 8px 0 0; padding: 10px 14px; border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 6px); background: var(--surface); color: var(--fg); font: inherit; font-size: 13px; font-weight: 600; line-height: 1.3; white-space: normal; overflow-wrap: anywhere; cursor: pointer; }
${workspace} button:disabled,
${workspace} button[aria-disabled="true"] { opacity: .65; cursor: default; }
${workspace} button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-weak); }
${workspace} .ai-models-choice-row { gap: 8px; margin: 0; }
${workspace} .ai-models-choice-row button { min-height: 44px; margin: 0; }
${workspace} .ai-models-choice-row button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
${workspace} :is([data-recued-ai-models-slot-save], [data-recued-ai-models-pool-add], [data-recued-ai-models-pool-save], [data-recued-ai-models-prompt-save], [data-recued-ai-models-budget-save]) { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
${workspace} :is([data-recued-ai-models-slot-clear], [data-recued-ai-models-pool-remove]) { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); color: var(--danger); }
${workspace} :is([data-recued-ai-models-slot-clear-confirm], [data-recued-ai-models-pool-remove-confirm], .rx-btn-danger) { border-color: var(--danger); background: var(--danger); color: var(--on-danger, #fff); }
${workspace} :is(.ai-models-actions, .ai-models-confirm-actions) { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
${workspace} :is(.ai-models-actions, .ai-models-confirm-actions) > button { margin: 0; }
${workspace} .ai-models-actions > :is(.ai-models-probe, .ai-models-form-error) { flex: 1 1 100%; width: 100%; margin: 0; }
${workspace} .ai-models-actions:empty { display: none; }
${workspace} .ai-models-probe { display: grid; gap: 8px; padding: 12px; }
${workspace} :is(.ai-models-probe-verdict, .ai-models-probe-facts, .ai-models-probe-detail, .ai-models-pool-data-use, .ai-models-usage) { margin: 0; line-height: 1.5; }
${workspace} .ai-models-probe-detail { white-space: pre-wrap; overflow-wrap: anywhere; }
${workspace} .ai-models-hint { margin-top: 6px; line-height: 1.5; }
${workspace} a { display: inline-flex; align-items: center; min-height: 44px; white-space: normal; overflow-wrap: anywhere; }
${workspace} summary { min-height: 44px; padding: 10px 0; cursor: pointer; }
${workspace} label:has(input:is([type="checkbox"], [type="radio"])) { min-height: 44px; }
${workspace} .ai-models-prompt-policy { margin: 0; padding-top: 14px; }
${workspace} .ai-models-confirm-dialog { max-width: min(100%, 520px); padding: 20px; }
@media (max-width: 560px) {
  ${workspace} .ai-models-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;
