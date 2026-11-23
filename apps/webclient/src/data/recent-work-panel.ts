import type { CollectionRecord, WorkEntity, WorkEntityGetRpcResponse, UniversalSearchResultType, SourceRegistration } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { recentRecordNoun, type RecentWorkRecord, type RecentWorkEntityRecord, type RecentSourceRecord, type RecentWorkRecords } from './recent-work-records.js';
import type { CheckedDraftOrigin } from './draft-origin.js';

export const RECENT_WORK_ACTION = 'recent-work-';
export const RECENT_WORK_KIND = 'data-recent-work-kind';
export const RECENT_WORK_ID = 'data-recent-work-id';
export const RECENT_WORK_FOCUS = 'data-recent-work-focus';
export const PINNED_WORK_ACTION = 'pinned-work-';
export const PINNED_WORK_KIND = 'data-pinned-work-kind';
export const PINNED_WORK_ID = 'data-pinned-work-id';
export interface RecentWorkFocus { action: string; kind: string | null; id: string | null; }
type Entity = Extract<WorkEntity, { _kind: 'task' | 'note' }>;
export type CheckedRecentSource = Exclude<CheckedDraftOrigin, { kind: 'note' | 'mail' }>
  | Extract<CheckedDraftOrigin, { kind: 'mail' }> & { record: CollectionRecord };

export const createRecentWorkPanel = (deps: {
  recent?: RecentWorkRecords;
  variant?: 'pinned';
  scope: () => string | null;
  blocked: () => boolean;
  read?: (record: RecentWorkEntityRecord) => Promise<WorkEntityGetRpcResponse>;
  readSource?: (record: RecentSourceRecord) => Promise<CheckedRecentSource>;
  sources?: () => Promise<readonly SourceRegistration[]>;
  open: (entity: Entity, freshness: WorkEntityGetRpcResponse['source_freshness'], sources?: readonly SourceRegistration[]) => Promise<void>;
  openSource?: (record: RecentSourceRecord, checked: CheckedRecentSource) => Promise<void>;
  changed: () => void;
  focus: (target: RecentWorkFocus | null) => void;
}) => {
  const pinned = deps.variant === 'pinned', prefix = pinned ? PINNED_WORK_ACTION : RECENT_WORK_ACTION;
  const kindAttr = pinned ? PINNED_WORK_KIND : RECENT_WORK_KIND, idAttr = pinned ? PINNED_WORK_ID : RECENT_WORK_ID;
  const focusAttr = pinned ? 'data-pinned-work-focus' : RECENT_WORK_FOCUS, title = pinned ? 'Pinned' : 'Recently opened';
  let operation: { scope: string; record: RecentWorkRecord } | null = null;
  let notice: { error: boolean; text: string } | undefined;
  let lastScope: string | null = null;
  const current = () => {
    const scope = deps.scope();
    if (scope !== lastScope) { operation = null; notice = undefined; lastScope = scope; }
    return scope;
  };
  const open = async (kind: string | null, id: string | null): Promise<void> => {
    const scope = current();
    if (scope === null || operation || deps.blocked()) return;
    const record = deps.recent?.list().find(record => record.kind === kind && record.id === id); if (!record) return;
    if ('origin' in record ? !deps.readSource || !deps.openSource : !deps.read) return;
    const op = { scope, record }; operation = op; notice = undefined; deps.changed();
    const alive = () => operation === op && deps.scope() === scope;
    try {
      if ('origin' in record) {
        const checked = await deps.readSource!(record);
        if (checked.kind !== record.kind) throw new Error('This record could not be confirmed. Try again or remove it from Recently opened.');
        if (alive() && !deps.blocked()) await deps.openSource!(record, checked);
        return;
      }
      const [response, sources] = await Promise.all([deps.read!(record), deps.sources?.().catch(() => undefined)]);
      if (!alive()) return;
      const entity = response.entity;
      if (!entity || entity._kind !== kind || entity.id !== id) throw new Error(`This ${record.kind} is no longer available. Try again or remove it from Recently opened.`);
      if (entity.source_id !== record.source_id || entity.created_at !== record.created_at)
        throw new Error(`This ${record.kind} changed identity. Open it from ${record.kind === 'task' ? 'Tasks' : 'Notes'} to review it.`);
      if (pinned && (entity.deleted_at != null || entity.sync_state === 'tombstoned' || entity.sync_state === 'orphaned'
        || (entity.source_record_id ?? null) !== (record.source_record_id ?? null))) throw new Error(`This ${record.kind} is no longer available with the same identity. Unpin it and open it from its collection to review it.`);
      if (deps.blocked()) return;
      await deps.open(entity as Entity, response.source_freshness, sources);
    } catch (error) {
      if (alive()) notice = { error: true, text: humanizeRpcError(error).replace('Your draft is still here.', 'Try again or remove it from Recently opened.').replace(/Recently opened/gu, title) };
    } finally {
      if (operation === op) { operation = null; if (deps.scope() === scope) deps.changed(); }
    }
  };
  return {
    reset() { operation = null; notice = undefined; },
    open,
    handle(action: string, kind: string | null, id: string | null, resultType: UniversalSearchResultType): boolean {
      if (!action.startsWith(prefix)) return false;
      if (current() === null || !deps.recent) return true;
      if (action === `${prefix}open`) { void open(kind, id); return true; }
      if (action !== `${prefix}remove` && action !== `${prefix}clear`) return true;
      const before = deps.recent.list();
      const record = before.find(record => record.kind === kind && record.id === id);
      const clear = action === `${prefix}clear`; if (!clear && !record) return true;
      const success = clear ? deps.recent.clear() : deps.recent.remove(record!.kind, record!.id);
      if (success && (clear || operation?.record.kind === kind && operation.record.id === id)) operation = null;
      notice = { error: !success, text: success ? clear ? 'Recently opened history cleared.' : pinned ? 'Record unpinned.' : 'Record removed from Recently opened.' : pinned ? 'Could not remove this pin. Try again.' : 'Could not update recently opened history. Try again.' };
      const visible = (rows: readonly RecentWorkRecord[]) => rows.filter(row => resultType === 'all' || row.kind === resultType);
      const after = visible(deps.recent.list()), index = visible(before).findIndex(row => row.kind === kind && row.id === id);
      const target = after[Math.max(0, Math.min(index, after.length - 1))];
      deps.changed(); deps.focus(target ? { action: clear ? 'clear' : 'remove', kind: clear ? null : target.kind, id: clear ? null : target.id } : null);
      return true;
    },
    render(actionAttr: string, resultType: UniversalSearchResultType = 'all'): string {
      current();
      const records = deps.recent?.list().filter(record => resultType === 'all' || record.kind === resultType) ?? [];
      if (!records.length && !notice) return '';
      const attrs = (action: string, record?: RecentWorkRecord) => `${actionAttr}="${prefix}${action}" ${focusAttr}="${action}"${record ? ` ${kindAttr}="${record.kind}" ${idAttr}="${e(record.id)}"` : ''}`;
      return `<section class="rq-recent rq-recent-work" ${pinned ? 'data-pinned-work-panel' : 'data-recent-work-panel'} aria-labelledby="rq-${pinned ? 'pinned' : 'recent'}-work-title">
        <div class="rq-recent-head"><h2 id="rq-${pinned ? 'pinned' : 'recent'}-work-title">${title}</h2>${records.length && !pinned ? `<button type="button" class="rq-recent-clear" ${attrs('clear')}>Clear recently opened</button>` : ''}</div>
        ${records.length ? `<p class="rq-subtle">${pinned ? 'Shortcuts saved on this device' : 'Records opened in this tab'}</p><ul class="rq-recent-list">${records.map(record => `<li>
          <button type="button" class="rq-recent-run rq-recent-record" ${attrs('open', record)} aria-label="${e(`Open ${recentRecordNoun(record.kind)} ${record.title}`)}"${operation || deps.blocked() || ('origin' in record ? !deps.readSource || !deps.openSource : !deps.read) ? ' aria-disabled="true"' : ''}${operation?.record.kind === record.kind && operation.record.id === record.id ? ' aria-busy="true"' : ''}>
            <span>${e(record.title)}</span><small>${e(recentRecordNoun(record.kind).replace(/^./, character => character.toUpperCase()))} · ${e(record.source_label)}</small></button>
          <button type="button" class="rq-recent-remove" ${attrs('remove', record)} aria-label="${e(pinned ? `Unpin ${recentRecordNoun(record.kind)} ${record.title}` : `Remove ${recentRecordNoun(record.kind)} ${record.title} from recently opened`)}">${pinned ? 'Unpin' : 'Remove'}</button>
        </li>`).join('')}</ul>` : ''}
        ${operation ? `<p role="status">Opening ${recentRecordNoun(operation.record.kind)}…</p>` : ''}
        ${notice ? `<p class="${notice.error ? 'rq-error' : 'rq-subtle'}" role="${notice.error ? 'alert' : 'status'}">${e(notice.text)}</p>` : ''}
      </section>`;
    },
  };
};
