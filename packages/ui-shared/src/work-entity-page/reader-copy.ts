import { e } from '../template.js';

export interface WorkReaderCopyView {
  can_link: boolean;
  disabled: boolean;
  busy?: 'details' | 'link';
  notice?: { kind: 'ok' | 'error'; text: string };
  fallback?: { label: string; value: string; select_label: string };
}

export const renderReaderCopyFallback = (view: WorkReaderCopyView | undefined, kind: 'task' | 'note' | 'commitment' | 'booking'): string => {
  const value = view?.fallback;
  return value ? `<section class="work-reader-copy-fallback" aria-label="Copy manually">
    <label for="work-reader-copy-value">${e(value.label)}</label>
    <textarea id="work-reader-copy-value" data-work-copy-value data-${kind}-focus="copy-value" readonly rows="4" spellcheck="false">${e(value.value)}</textarea>
    <button type="button" data-action="work-copy-select" data-${kind}-focus="copy-select">${e(value.select_label)}</button>
  </section>` : '';
};
