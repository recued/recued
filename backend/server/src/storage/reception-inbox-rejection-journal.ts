import type { ReceptionInboxTopTierKind } from '@recued/contracts';
import type { Collection } from '@recued/storage';

export interface InboxRejectionHistory {
  top_tier_kind: ReceptionInboxTopTierKind;
  source_record_ref: string;
  reason?: string;
  door_contract_id?: string;
}

/** Only correlation and history metadata; never a copy of the held payload. */
export interface PendingInboxRejection {
  attempt_id: string;
  hold_id: string;
  run_id: string;
  recipe_id: string;
  gated_step_id: string;
  rejected_at: number;
  phase: 'prepared' | 'accepted';
  history: InboxRejectionHistory;
}

export interface InboxRejectionJournal {
  get(holdId: string): Promise<PendingInboxRejection | null>;
  list(): Promise<PendingInboxRejection[]>;
  prepare(entry: PendingInboxRejection): Promise<void>;
  accept(entry: PendingInboxRejection): Promise<void>;
  remove(entry: PendingInboxRejection): Promise<void>;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const createInboxRejectionJournal = (backing: Collection<PendingInboxRejection>): InboxRejectionJournal => {
  const get = async (holdId: string): Promise<PendingInboxRejection | null> => {
    const entry = await backing.get(holdId);
    if (entry === null) return null;
    if (entry.hold_id !== holdId || [entry.attempt_id, entry.run_id, entry.recipe_id, entry.gated_step_id]
      .some(value => typeof value !== 'string' || value.length === 0)
      || !Number.isFinite(entry.rejected_at) || !['prepared', 'accepted'].includes(entry.phase)) {
      throw new Error('Invalid inbox rejection journal binding');
    }
    return copy(entry);
  };
  return {
    get,
    list: async () => copy(await backing.list()),
    async prepare(entry) {
      if (await get(entry.hold_id)) throw new Error('An inbox rejection attempt is already pending');
      await backing.set(entry.hold_id, copy(entry));
    },
    async accept(entry) {
      const current = await get(entry.hold_id);
      if (current?.attempt_id !== entry.attempt_id) throw new Error('Inbox rejection attempt changed');
      await backing.set(entry.hold_id, { ...current, phase: 'accepted' });
    },
    async remove(entry) {
      if ((await get(entry.hold_id))?.attempt_id === entry.attempt_id) await backing.delete(entry.hold_id);
    },
  };
};
