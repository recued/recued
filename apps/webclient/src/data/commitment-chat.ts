import type { WorkEntity } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { readExactRecordLink } from './exact-record-link.js';
import type { DataWorkEntityGetCaller } from './bootstrap-data-route.js';
import type { PreparedRecordLink } from './record-link-insert.js';

/** The chat receives an ordinary selected-record reference. Its body is read
 * through the governed work reader when the owner asks their question. */
export const createWorkRecordChat = (deps: {
  get?: DataWorkEntityGetCaller; href(): string;
  open?: (record: PreparedRecordLink) => void;
  beforeLeave(): boolean; changed(): void;
}) => {
  type Operation = { entity: Extract<WorkEntity, { _kind: 'commitment' | 'booking' | 'project' }>; current(): boolean; busy: boolean; error?: string };
  let operation: Operation | undefined;
  const owns = (op: Operation) => operation === op && op.current();
  const available = (entity: Extract<WorkEntity, { _kind: 'commitment' | 'booking' | 'project' }>) => !!deps.get && !!deps.open && entity.deleted_at == null && entity.sync_state !== 'tombstoned';
  return {
    reset() { operation = undefined; },
    view(entity: Extract<WorkEntity, { _kind: 'commitment' | 'booking' | 'project' }>) {
      const op = operation?.entity === entity && owns(operation) ? operation : undefined;
      return { available: available(entity), busy: op?.busy, error: op?.error };
    },
    async ask(entity: Extract<WorkEntity, { _kind: 'commitment' | 'booking' | 'project' }>, current: () => boolean): Promise<void> {
      if (!available(entity) || !current() || operation?.entity === entity && owns(operation) && operation.busy || !deps.beforeLeave()) return;
      const op: Operation = { entity, current, busy: true }; operation = op; deps.changed();
      try {
        const target = { tab: entity._kind, id: entity.id, hash: serializeShellRoute('data', entity._kind, entity.id) };
        const checked = await readExactRecordLink(target, { work: (kind, id) => deps.get!({ kind, id }) }, deps.href());
        if (!owns(op)) return;
        const expected = JSON.stringify([entity._kind, entity.id, entity.source_id, entity.source_record_id ?? null, entity.created_at]);
        if (checked.state !== 'ready' || checked.match.identity !== expected)
          throw new Error(`This ${entity._kind} was removed or replaced. Reopen it before starting a chat.`);
        if (!deps.beforeLeave()) return;
        deps.open!({ reference: checked.match });
      } catch (error) { if (owns(op)) op.error = humanizeRpcError(error); }
      finally { if (owns(op)) { op.busy = false; deps.changed(); } }
    },
  };
};

export const createCommitmentChat = createWorkRecordChat;
