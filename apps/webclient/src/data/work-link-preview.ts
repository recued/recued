import { dueDayIso, isMentionOnlyEmail, type Asset, type ContactRecord, type WorkEntity, type WorkEntityGetRpcResponse, type CollectionRecord, type CollectionSourceFreshness } from '@recued/contracts';
import { bookingTimeLabel, bookingReaderWarning, commitmentDeadlineLabel, commitmentDirectionLabel, commitmentReaderWarning, commitmentStatusLabel, taskDeadlineLabel, taskReaderWarning } from '@recued/ui-shared/work-entity-page';
import { sourceRecordLinkDetails } from './source-record-link.js';
import type { WorkReaderLink } from './task-note-source.js';

export type RecordLinkTarget = WorkReaderLink | { tab: 'asset'; id: string; hash: string };

export interface WorkLinkPreviewReaders {
  asset?: (id: string) => Promise<Pick<Asset, 'id' | 'name' | 'status' | 'created_at' | 'deleted_at' | 'sync_state'> | null>;
  source?: (args: { platform: 'mail' | 'calendar'; slug: string; record_id: string }) => Promise<{ record: CollectionRecord | null; source_freshness?: CollectionSourceFreshness }>;
  contact?: (id: string) => Promise<{ contact: ContactRecord | null }>;
  work?: (kind: 'task' | 'note' | 'commitment' | 'booking' | 'project', id: string) => Promise<WorkEntityGetRpcResponse>;
}
export type WorkLinkPreviewResult =
  | { state: 'ready'; title: string; details: string[]; excerpt?: string; warning?: string }
  | { state: 'missing'; message: string };
export type WorkLinkPreviewView = { owner: string; key: string; target: WorkReaderLink } & (
  WorkLinkPreviewResult | { state: 'loading' } | { state: 'error'; message: string });
const brief = (text: string, limit = 180): string => {
  const chars = Array.from(text.replace(/\s+/gu, ' ').trim());
  return chars.slice(0, limit).join('') + (chars.length > limit ? '…' : '');
};
const unavailable = (target: RecordLinkTarget): WorkLinkPreviewResult =>
  ({ state: 'missing', message: 'This ' + target.tab + ' is no longer available.' });
class PreviewReadError extends Error {}
const unconfirmed = (target: RecordLinkTarget) => new PreviewReadError('This linked ' + target.tab + ' could not be confirmed. Try again.');

/** Read the saved record only after Preview is requested. A preview is never
 * passed back as a confirmed record or permission to edit. */
export const readWorkLinkPreview = async (target: RecordLinkTarget, readers: WorkLinkPreviewReaders, receivedAt?: number): Promise<WorkLinkPreviewResult> => {
  if (target.tab === 'asset') {
    if (!readers.asset) throw new PreviewReadError('Yours asset previews are unavailable here.');
    const asset = await readers.asset(target.id);
    if (!asset || asset.deleted_at != null || asset.sync_state === 'tombstoned') return unavailable(target);
    if (asset.id !== target.id) throw unconfirmed(target);
    return { state: 'ready', title: brief(asset.name || 'Asset', 240),
      details: ['Yours', 'Status: ' + asset.status.replaceAll('_', ' ')] };
  }
  if (!('id' in target)) {
    if (!readers.source) throw new PreviewReadError('Source previews are unavailable here.');
    const { record, source_freshness } = await readers.source({ platform: target.tab, slug: target.collectionSlug, record_id: target.recordId });
    if (!record) return unavailable(target);
    if (record.record_id !== target.recordId || receivedAt !== undefined && record.received_at !== receivedAt) throw unconfirmed(target);
    return { state: 'ready', ...sourceRecordLinkDetails(target.tab, target.collectionSlug, record.hot_fields, record.received_at),
      ...(typeof record.body_inline === 'string' && record.body_inline.trim() ? { excerpt: brief(record.body_inline) } : {}),
      ...(source_freshness?.stale ? { warning: 'The saved record may be out of date.' } : {}) };
  }
  if (target.tab === 'contact') {
    if (!readers.contact) throw new PreviewReadError('Contact previews are unavailable here.');
    const { contact } = await readers.contact(target.id);
    if (!contact) return unavailable(target);
    if (contact.contact_id !== target.id && contact.email.toLocaleLowerCase('en-US') !== target.id.toLocaleLowerCase('en-US')) throw unconfirmed(target);
    const email = isMentionOnlyEmail(contact.email) ? '' : contact.email;
    return { state: 'ready', title: brief(contact.name?.trim() || email || 'Contact', 240),
      details: [email, contact.phone, contact.company].filter((value): value is string => typeof value === 'string' && !!value.trim()).map(value => brief(value)), ...(contact.merged_into !== undefined ? { warning: 'This contact was merged. Open it to review the saved link.' } : {}) };
  }
  if (!readers.work) throw new PreviewReadError('Record previews are unavailable here.');
  const { entity, source_freshness } = await readers.work(target.tab, target.id);
  if (!entity) return unavailable(target);
  if (entity._kind !== target.tab || entity.id !== target.id) throw unconfirmed(target);
  if (entity.deleted_at != null || entity.sync_state === 'tombstoned') return unavailable(target);
  const freshnessWarning = source_freshness && source_freshness.state !== 'local' && source_freshness.state !== 'fresh'
    ? 'The saved record may be out of date.' : undefined;
  if (entity._kind === 'task') return { state: 'ready', title: brief(entity.title || 'Task', 240),
    ...(entity.body?.trim() ? { excerpt: brief(entity.body) } : {}),
    details: [entity.done ? 'Completed' : 'Open', 'Due date: ' + taskDeadlineLabel(entity)], warning: taskReaderWarning(entity) || freshnessWarning };
  if (entity._kind === 'commitment') return { state: 'ready', title: brief(entity.statement.trim() || 'Commitment', 240),
    details: [commitmentDirectionLabel(entity.direction), 'Saved status: ' + commitmentStatusLabel(entity), 'Deadline: ' + commitmentDeadlineLabel(entity)],
    excerpt: brief(entity.statement), warning: commitmentReaderWarning(entity) || freshnessWarning };
  if (entity._kind === 'booking') return { state: 'ready', title: brief(entity.title || 'Booking', 240),
    details: ['Saved status: ' + entity.lifecycle_state.replace('_', ' '), 'Starts: ' + bookingTimeLabel(entity.slot_start_at), 'Ends: ' + bookingTimeLabel(entity.slot_end_at),
      ...(entity.monetary_value ? ['Value: ' + entity.monetary_value.amount + ' ' + entity.monetary_value.currency] : [])],
    warning: bookingReaderWarning(entity) || freshnessWarning };
  if (entity._kind === 'project') return { state: 'ready', title: brief(entity.title || 'Project', 240),
    details: ['Saved status: ' + entity.state, ...(entity.target_completion_at === undefined ? [] : ['Target: ' + (dueDayIso(entity.target_completion_at) ?? new Date(entity.target_completion_at).toISOString())])],
    ...(entity.description?.trim() ? { excerpt: brief(entity.description) } : {}),
    warning: entity.pending_write ? 'A change is waiting for source confirmation.' : entity.sync_state !== 'live' ? 'The saved project may be out of date.' : freshnessWarning };
  const note = entity as Extract<WorkEntity, { _kind: 'note' }>;
  return { state: 'ready', title: brief(note.title?.trim() || 'Note', 240), details: [],
    excerpt: brief(note.body) || 'No note text.',
    warning: note.pending_write ? 'A change is waiting for source confirmation.'
      : note.sync_state === 'orphaned' ? 'This note’s source was removed.'
      : note.sync_state !== 'live' ? 'This source cannot be reached. The note may be out of date.' : freshnessWarning };
};

export const createWorkLinkPreview = (deps: {
  owner: () => string | null;
  read: (target: WorkReaderLink) => Promise<WorkLinkPreviewResult>;
  changed: () => void;
}) => {
  let available: ReadonlyMap<string, WorkReaderLink> = new Map(), binding: string | null = null;
  let view: WorkLinkPreviewView | null = null, disposed = false;
  const valid = (op: WorkLinkPreviewView | null): op is WorkLinkPreviewView => !!op && !disposed
    && binding === op.owner && deps.owner() === op.owner && available.get(op.key)?.hash === op.target.hash;
  const state = (): WorkLinkPreviewView | null => { if (!valid(view)) view = null; return view; };
  const close = () => { if (view) { view = null; deps.changed(); } };
  const open = async (key: string): Promise<void> => {
    const owner = deps.owner(), target = available.get(key);
    if (disposed || !owner || owner !== binding || !target || state()?.key === key && view?.state === 'loading') return;
    const pending: WorkLinkPreviewView = { owner, key, target, state: 'loading' };
    view = pending; deps.changed();
    try {
      const result = await deps.read(target);
      if (view !== pending || !valid(pending)) return;
      view = { owner, key, target, ...result };
    } catch (error) {
      if (view !== pending || !valid(pending)) return;
      view = { owner, key, target, state: 'error',
        message: error instanceof PreviewReadError
          ? error.message : 'This record could not be loaded. Try again.' };
    }
    deps.changed();
  };
  return { state, open, close,
    bind(owner: string | null, targets: ReadonlyMap<string, WorkReaderLink>) {
      binding = owner; available = new Map(targets); state();
    },
    dispose() { disposed = true; view = null; available = new Map(); binding = null; },
  };
};
