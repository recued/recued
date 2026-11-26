export const FILE_BROWSER_DESKTOP_MEDIA = '(min-width: 1280px) and (hover: hover) and (pointer: fine)';
export const FILE_SOURCE_OPTIONS = '[data-file-source-options]';

export const FILE_BROWSER_TOOLBAR_STYLES = `
.file-browser-toolbar {
  display:flex; align-items:center; flex-wrap:wrap; gap:8px; min-width:0;
  padding:8px 10px; margin:0 0 12px; border:1px solid var(--border);
  border-radius:var(--wc-radius-lg,12px); background:var(--surface);
}
.file-browser-sources { flex:1 1 min(220px,100%); min-width:0; }
.file-browser-source-label { color:var(--fg); font-size:14px; font-weight:650; overflow-wrap:anywhere; }
.file-browser-toolbar :is(.data-button,.col-explorer-instance-chip),
.files-desktop .saved-file-controls .data-button { appearance:none; }
.file-browser-toolbar .col-explorer-instance-chip { min-height:var(--wc-control-h,40px); border-radius:var(--wc-radius,9px); }
.file-browser-toolbar .col-explorer-instance-chip.is-active {
  background:var(--accent-weak,var(--surface-sunk)); color:var(--accent); border-color:var(--border);
  font-weight:650;
}
.file-browser-toolbar > .data-button, .file-browser-toolbar summary, .file-browser-toolbar .upload-dropzone {
  display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box;
  min-height:var(--wc-control-h,40px); padding:6px 12px; border-radius:var(--wc-radius,9px); font-weight:600;
}
.file-browser-toolbar [data-file-source-options] { position:relative; }
.file-browser-toolbar summary { list-style:none; gap:8px; cursor:pointer; }
.file-browser-toolbar summary::-webkit-details-marker { display:none; }
.file-browser-toolbar summary::after {
  content:""; width:6px; height:6px; border-inline-end:1.5px solid; border-block-end:1.5px solid;
  transform:translateY(-2px) rotate(45deg);
}
.file-browser-toolbar details[open] summary::after { transform:translateY(2px) rotate(225deg); }
.file-browser-toolbar .data-file-sources {
  position:absolute; inset-block-start:calc(100% + 6px); inset-inline-end:0; z-index:4;
  box-sizing:border-box; width:min(350px,90vw); margin:0; padding:12px;
  border-radius:var(--wc-radius-lg,12px); background:var(--surface); box-shadow:0 8px 24px rgb(0 0 0 / .16);
}
.file-browser-toolbar .upload-widget { display:contents; }
.file-browser-toolbar .upload-dropzone {
  position:relative; background:var(--accent); color:var(--on-accent); border:1px solid var(--accent);
}
.file-browser-toolbar .upload-dropzone[data-dragover] {
  background:var(--surface-sunk); color:var(--accent); border-style:dashed;
}
.file-browser-toolbar .upload-dropzone:has(.upload-input:focus-visible),
.file-browser-toolbar :is(summary,button):focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.file-browser-toolbar .upload-progress { order:1; flex:1 1 100%; min-width:0; }
.file-browser-toolbar .upload-row { flex-wrap:wrap; }
.file-browser-toolbar .upload-status { flex-shrink:1; min-width:0; overflow-wrap:anywhere; }
.files-desktop .saved-file-results[data-saved-file-preview-open] { margin-block-start:0; }
.saved-file-controls { margin-block-end:12px; min-width:0; }
.files-desktop .saved-file-controls .data-file-search { margin:0; }
.files-desktop .saved-file-controls:has(> .file-batch-select-shown) {
  display:grid; grid-template-columns:minmax(0,1fr) var(--wc-task-action-width,7.5rem); align-items:end; gap:8px 12px;
}
.files-desktop .saved-file-controls:has(> .file-batch-select-shown) .data-file-search { display:contents; }
.files-desktop .saved-file-controls:has(> .file-batch-select-shown) [data-saved-file-status] {
  grid-column:1; grid-row:2; align-self:center;
}
.file-batch-select-shown { grid-column:2; grid-row:2; min-width:0; }
.file-batch-select-shown .data-button {
  width:100%; min-height:var(--wc-control-h,40px); border-radius:var(--wc-radius,9px); font-weight:600;
}
.files-desktop .file-batch--compact {
  display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px;
  margin:8px 0 0; padding:8px 10px; border-radius:var(--wc-radius,9px);
}
.file-batch--compact p { flex-basis:100%; }
.files-desktop .file-batch--compact .data-button { min-height:34px; white-space:nowrap; }
`;
