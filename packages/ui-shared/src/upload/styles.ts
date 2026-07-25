/** Shared resumable-upload widget — CSS.
 *
 *  Single block injected once by the host surface (same pattern as
 *  REF_PICKER_STYLES / FORM_RENDERER_STYLES). Classes are scoped under
 *  `upload-*`. Inherits the shell's light/dark tokens.
 */

export const UPLOAD_STYLES = `
.upload-widget {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0;
}

.upload-dropzone {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px 12px;
  border: 1px dashed var(--color-border, var(--border));
  border-radius: 6px;
  background: var(--color-input-bg, var(--surface));
  color: var(--color-text-secondary, var(--fg-muted));
  font-size: 0.85rem;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.upload-dropzone:hover {
  border-color: var(--color-accent, var(--accent));
}

.upload-dropzone[data-dragover] {
  border-color: var(--color-accent, var(--accent));
  background: var(--color-chip-bg, var(--surface-sunk));
}

.upload-dropzone[data-busy] {
  opacity: 0.6;
  pointer-events: none;
}

/* Visually-hidden but focusable + label-clickable file input. */
.upload-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.upload-progress {
  display: block;
}

.upload-progress:empty {
  display: none;
}

.upload-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--color-chip-bg, var(--surface-sunk));
  font-size: 0.8rem;
}

.upload-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-bar {
  flex: 1 1 auto;
  height: 6px;
  border-radius: 3px;
  background: var(--color-border, var(--border));
  overflow: hidden;
}

.upload-bar-fill {
  height: 100%;
  background: var(--color-accent, var(--accent));
  transition: width 0.18s ease;
}

.upload-status {
  flex: 0 0 auto;
  color: var(--color-text-secondary, var(--fg-muted));
  font-variant-numeric: tabular-nums;
}

.upload-row--done .upload-status {
  color: var(--color-success, var(--accent));
}

.upload-row--error .upload-status {
  color: var(--color-warning, var(--danger));
}

.upload-cancel {
  flex: 0 0 auto;
  padding: 2px 8px;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.upload-cancel:hover {
  background: var(--color-input-bg, var(--surface));
}
`;
