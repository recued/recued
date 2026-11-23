import type { WorkEntity } from '@recued/contracts';
import { bookingTimeLabel, bookingReaderWarning, commitmentDeadlineLabel, commitmentDirectionLabel, commitmentReaderWarning, commitmentStatusLabel, taskDeadlineLabel, taskReaderWarning, type WorkReaderCopyView } from '@recued/ui-shared/work-entity-page';
import { serializeShellRoute } from '../shell/route.js';
import { recordLink } from '../shell/record-link.js';

export const WORK_COPY_ACTION = 'work-copy-';
type Task = Extract<WorkEntity, { _kind: 'task' }>;
export type WorkCopyAction = 'details' | 'link';
export interface WorkCopyOwner {
  entity: Extract<WorkEntity, { _kind: 'task' | 'note' | 'commitment' | 'booking' }>;
  version: number;
  href: string;
  counterparty_label?: string; source_label?: string;
}

export const taskCopyText = (task: Task): string => {
  const warning = taskReaderWarning(task);
  return [task.title.trim() || 'Task', `Status: ${task.done ? 'Completed' : 'Open'}`,
    ...(warning ? [`Source status: ${warning}`] : []),
    `Due date: ${taskDeadlineLabel(task)}`,
    `Priority: ${task.priority ? task.priority[0]!.toUpperCase() + task.priority.slice(1) : 'Not set'}`,
    ...(task.body ? ['', task.body] : []),
  ].join('\n');
};

export const commitmentCopyText = (entity: Extract<WorkEntity, { _kind: 'commitment' }>, labels: { counterparty_label?: string; source_label?: string } = {}): string => {
  const warning = commitmentReaderWarning(entity);
  return [entity.statement.trim() || 'Commitment', `Direction: ${commitmentDirectionLabel(entity.direction)}`,
    `Saved status: ${commitmentStatusLabel(entity)}`, ...(warning ? [`Source status: ${warning}`] : []),
    `With: ${labels.counterparty_label ?? (entity.counterparty_contact_id ? 'Contact unavailable' : 'No contact linked')}`,
    `Deadline: ${commitmentDeadlineLabel(entity)}`,
    ...(entity.monetary_value ? [`Amount: ${entity.monetary_value.amount} ${entity.monetary_value.currency}`] : []),
    `Source: ${labels.source_label ?? 'Source unavailable'}`].join('\n');
};

export const bookingCopyText = (entity: Extract<WorkEntity, { _kind: 'booking' }>, customer = 'Customer unavailable'): string => {
  const warning = bookingReaderWarning(entity);
  return [entity.title.trim() || 'Booking', 'Saved status: ' + entity.lifecycle_state.replace('_', ' '),
    ...(warning ? ['Source status: ' + warning] : []), 'Customer: ' + customer,
    'Starts: ' + bookingTimeLabel(entity.slot_start_at), 'Ends: ' + bookingTimeLabel(entity.slot_end_at),
    'Value: ' + (entity.monetary_value ? entity.monetary_value.amount + ' ' + entity.monetary_value.currency : 'Not set')].join('\n');
};

/** Keep the app's deployment path, without pairing parameters or return/view
 * context. The regular paired-webclient route still owns access to the record. */
export const workRecordLink = (href: string, kind: 'task' | 'note' | 'commitment' | 'booking', id: string): string | null => {
  return id ? recordLink(href, serializeShellRoute('data', kind, id)) : null;
};

export const createWorkReaderCopy = (deps: {
  current: () => WorkCopyOwner | null;
  blocked: () => boolean;
  write: (value: string) => Promise<boolean>;
  beforeStart: (kind: 'task' | 'note' | 'commitment' | 'booking') => void;
  render: () => void;
  focusAction: (action: WorkCopyAction) => void;
  actionFocused: (action: WorkCopyAction) => boolean;
  selectFallback: () => void;
}) => {
  type Operation = WorkCopyOwner & { action: WorkCopyAction; busy: boolean; notice?: WorkReaderCopyView['notice']; fallback?: WorkReaderCopyView['fallback'] };
  let operation: Operation | null = null;
  const matches = (owner: WorkCopyOwner | null, op = operation) => !!owner && !!op && owner.entity === op.entity && owner.version === op.version;
  const reset = () => { operation = null; };
  const state = (): WorkReaderCopyView | undefined => {
    const owner = deps.current();
    if (!matches(owner)) reset();
    if (!owner) return undefined;
    return { can_link: workRecordLink(owner.href, owner.entity._kind, owner.entity.id) !== null,
      disabled: deps.blocked() || operation?.busy === true, busy: operation?.busy ? operation.action : undefined,
      notice: operation?.notice, fallback: operation?.fallback };
  };
  const copy = async (action: WorkCopyAction): Promise<boolean> => {
    const owner = deps.current();
    if (!owner || state()?.disabled || action === 'details' && owner.entity._kind === 'note') return false;
    const value = action === 'link' ? workRecordLink(owner.href, owner.entity._kind, owner.entity.id)
      : owner.entity._kind === 'booking' ? bookingCopyText(owner.entity, owner.counterparty_label) : owner.entity._kind === 'commitment' ? commitmentCopyText(owner.entity, owner) : taskCopyText(owner.entity as Task);
    if (value === null) return false;
    const op: Operation = { ...owner, action, busy: true }; operation = op;
    deps.beforeStart(owner.entity._kind); deps.render(); deps.focusAction(action);
    let copied = false;
    try { copied = await deps.write(value); } catch { /* Offer the captured value for manual copying. */ }
    if (operation !== op || !matches(deps.current(), op)) return false;
    const carryFocus = deps.actionFocused(action);
    op.busy = false;
    const noun = owner.entity._kind === 'booking' ? 'Booking summary' : owner.entity._kind === 'commitment' ? 'Commitment summary' : 'Task details';
    op.notice = copied ? { kind: 'ok', text: action === 'link' ? 'Link copied.' : noun + ' copied.' }
      : { kind: 'error', text: action === 'link' ? 'Copy did not complete. Select the link and copy it.' : owner.entity._kind === 'booking' ? 'Copy did not complete. Select the booking summary and copy it.' : owner.entity._kind === 'commitment' ? 'Copy did not complete. Select the commitment summary and copy it.' : 'Copy did not complete. Select the task details and copy them.' };
    op.fallback = copied ? undefined : { label: action === 'link' ? `Link to this ${owner.entity._kind}` : noun + ' to copy', value,
      select_label: action === 'link' ? 'Select link' : 'Select ' + noun.toLowerCase() };
    deps.render();
    if (carryFocus) { if (copied) deps.focusAction(action); else deps.selectFallback(); }
    return copied;
  };
  return { reset, state, copy, busy: () => state()?.busy !== undefined,
    handle(action: string): boolean {
      if (action === 'work-copy-details') { void copy('details'); return true; }
      if (action === 'work-copy-link') { void copy('link'); return true; }
      if (action === 'work-copy-select' && state()?.fallback) { deps.selectFallback(); return true; }
      return false;
    },
  };
};
