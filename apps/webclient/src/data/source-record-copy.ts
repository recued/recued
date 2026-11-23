import { e } from '@recued/ui-shared';
import { recordLink } from '../shell/record-link.js';
import { draftOriginHash, readDraftOrigin } from './draft-origin.js';
import { recentRecordNoun, type RecentSourceOrigin, type RecentSourceRecord } from './recent-work-records.js';

export const SOURCE_COPY_ACTION = 'source-record-copy-';
export const SOURCE_COPY_FOCUS = 'data-source-copy-focus';
export const SOURCE_COPY_VALUE = 'data-source-copy-value';
export interface SourceRecordCopyOwner { record: RecentSourceRecord; scope: string; href: string; }
export interface SourceRecordCopyView {
  kind: RecentSourceRecord['kind']; can_link: boolean; disabled: boolean; busy: boolean;
  notice?: { error: boolean; text: string }; fallback?: string;
}

export const sourceRecordLink = (href: string, origin: RecentSourceOrigin): string | null => {
  const checked = readDraftOrigin(origin);
  return checked && checked.kind !== 'note' ? recordLink(href, draftOriginHash(checked)) : null;
};
const ownerKey = (owner: SourceRecordCopyOwner) => JSON.stringify([owner.scope, { ...owner.record.origin, label: '' },
  sourceRecordLink(owner.href, owner.record.origin)]);

/** Copy only the currently displayed, confirmed record's address. A delayed
 * clipboard result cannot report success or offer a fallback in a new reader. */
export const createSourceRecordCopy = (deps: {
  current: () => SourceRecordCopyOwner | null; blocked: () => boolean;
  write: (value: string) => Promise<boolean>; render: () => void;
  focusAction: () => void; actionFocused: () => boolean; selectFallback: () => void;
}) => {
  let operation: { key: string; busy: boolean; notice?: SourceRecordCopyView['notice']; fallback?: string } | null = null;
  const reset = () => { operation = null; };
  const matches = (owner: SourceRecordCopyOwner | null, op = operation) => !!owner && !!op && ownerKey(owner) === op.key;
  const state = (): SourceRecordCopyView | undefined => {
    const owner = deps.current(); if (!matches(owner)) reset();
    if (!owner) return undefined;
    return { kind: owner.record.kind, can_link: sourceRecordLink(owner.href, owner.record.origin) !== null,
      disabled: deps.blocked() || operation?.busy === true, busy: operation?.busy === true,
      notice: operation?.notice, fallback: operation?.fallback };
  };
  const copy = async (): Promise<boolean> => {
    const owner = deps.current(); if (!owner || state()?.disabled) return false;
    const value = sourceRecordLink(owner.href, owner.record.origin); if (value === null) return false;
    const op: NonNullable<typeof operation> = { key: ownerKey(owner), busy: true }; operation = op;
    deps.render(); deps.focusAction();
    let copied = false; try { copied = await deps.write(value); } catch { /* The captured link remains available for manual copying. */ }
    if (operation !== op || !matches(deps.current(), op)) return false;
    const carryFocus = deps.actionFocused(); op.busy = false;
    op.notice = { error: !copied, text: copied ? 'Link copied.' : 'Copy did not complete. Select the link and copy it.' };
    op.fallback = copied ? undefined : value; deps.render();
    if (carryFocus) { if (copied) deps.focusAction(); else deps.selectFallback(); }
    return copied;
  };
  return { state, copy, reset, busy: () => state()?.busy === true,
    key: () => { const owner = deps.current(); return owner ? ownerKey(owner) : null; },
    handle(action: string): boolean {
      if (action === 'source-record-copy-link') { void copy(); return true; }
      if (action === 'source-record-copy-select' && state()?.fallback) { deps.selectFallback(); return true; }
      return false;
    },
  };
};

export const renderSourceRecordCopy = (view: SourceRecordCopyView, actionAttr: string): string => {
  const noun = recentRecordNoun(view.kind);
  return `<button type="button" class="data-button" ${actionAttr}="source-record-copy-link" ${SOURCE_COPY_FOCUS}="link"${view.can_link ? '' : ' disabled'}${view.disabled ? ' aria-disabled="true"' : ''}${view.busy ? ' aria-busy="true"' : ''}>${view.busy ? 'Copying…' : 'Copy link'}</button>
    ${view.notice ? `<span class="data-source-copy-notice" role="${view.notice.error ? 'alert' : 'status'}">${e(view.notice.text)}</span>` : ''}
    ${view.fallback ? `<div class="data-source-copy-fallback"><label for="source-record-copy-value">Link to this ${noun}</label>
      <textarea id="source-record-copy-value" ${SOURCE_COPY_VALUE} ${SOURCE_COPY_FOCUS}="value" rows="2" readonly spellcheck="false">${e(view.fallback)}</textarea>
      <button type="button" class="data-button" ${actionAttr}="source-record-copy-select" ${SOURCE_COPY_FOCUS}="select">Select link</button></div>` : ''}`;
};
export const SOURCE_RECORD_COPY_STYLES = `
.data-source-copy-notice { font-size:.875rem; overflow-wrap:anywhere; }
.data-source-copy-fallback { flex:0 0 100%; min-width:0; display:grid; gap:.5rem; }
.data-source-copy-fallback textarea { box-sizing:border-box; width:100%; min-width:0; resize:vertical; overflow-wrap:anywhere; }
.data-source-copy-fallback .data-button { justify-self:start; }
`;
