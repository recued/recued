/** D-325: reminder transport receipts. The question and answer remain in AskStore.
 * These rows own only immutable destinations, send attempts and withdrawal jobs. */
import type { Collection } from '@recued/storage';
import type { NewPendingAsk } from './ask-store.js';
import type { ChannelName, InboundReply, NotificationMessage } from './types.js';

/** No credentials. A connection's enrollment stamp prevents a deleted/recreated
 * name from acquiring an old question. Recipient and principal are pinned too. */
export interface AskDeliveryDestination {
  id: string;
  channel: ChannelName;
  connection_name?: string;
  connection_enrolled_at?: number;
  recipient?: string;
  expected_sender?: string;
  /** Only a separately enrolled household reminder may authorize more than
   * the owner. Approval asks and private reminders never use this list. */
  audience?: 'household';
  allowed_senders?: string[];
  /** Email's original sending mailbox; changing a connection's sender is not
   * permission to send an existing question from a different account. */
  sender_source?: string;
}

export interface AskDestinationResolution {
  destinations: AskDeliveryDestination[];
  issues: { channel: ChannelName; reason: 'choice_required' | 'connection_missing' | 'adapter_unavailable'
    | 'configuration_invalid' | 'principal_missing' }[];
}

export interface AskDeliveryInput {
  group_id: string;
  asks: readonly {
    ask_id: string;
    message: NotificationMessage;
    ui_link_url?: string;
    options: NewPendingAsk['options'];
    handler: { kind: string; payload: Record<string, unknown> };
  }[];
  destinations: readonly AskDeliveryDestination[];
  /** Quiet hours move delivery, never the question's answerable lifetime. */
  not_before?: number;
}

export type AskDeliveryOutcome =
  | { outcome: 'delivered'; provider_message_id?: string; presentation?: 'buttons' | 'text' }
  /** `permanent`: this destination can never take the envelope (its pinned
   *  connection is gone or was replaced, or no durable adapter exists), so no
   *  retry follows. */
  | { outcome: 'not_delivered'; error?: string; permanent?: true }
  | { outcome: 'unknown'; error?: string };

export interface AskDeliveryAttempt {
  id: string;
  destination_id: string;
  started_at: number;
  repeat: boolean;
  /** Render membership at send time, retained for exact provider reconciliation. */
  closed_ask_ids?: string[];
  /** Absent after a crash means unknown, never not delivered. */
  result?: AskDeliveryOutcome;
}

export interface AskWithdrawalJob {
  attempt_id: string;
  ask_id: string;
  /** The position is immutable, including after other items close. */
  item: number;
  requested_at: number;
  acknowledged_at?: number;
  /** Failed edits back off; after too many the job is abandoned, so a deleted
   *  message or a removed credential cannot keep its group alive forever. */
  failures?: number;
  retry_at?: number;
  abandoned?: true;
}

export interface AskDeliveryGroup {
  kind: 'group';
  group_id: string;
  asks: NewPendingAsk[];
  destinations: AskDeliveryDestination[];
  not_before: number;
  created_at: number;
  asks_initialized: boolean;
  /** After closing superseded questions, a flow can prepare, recheck its
   * source, then release. Recovery never sends an unreleased envelope. */
  released?: boolean;
  /** Operational retention stamp; question lifecycle stays in AskStore. */
  closed_at?: number;
  attempts: AskDeliveryAttempt[];
  withdrawals: AskWithdrawalJob[];
}

export interface UnmatchedAskReply {
  kind: 'unmatched_reply';
  id: string;
  group_id: string;
  via: ChannelName;
  /** Bounded owner-visible text, never sent to a model or another destination. */
  text: string;
  /** `already_closed`: a valid answer that came after its reminder closed. */
  reason: 'item_required' | 'unknown_item' | 'unknown_option' | 'wrong_origin' | 'already_closed';
  created_at: number;
  dismissed_at?: number;
}

export type AskDeliveryRecord = AskDeliveryGroup | UnmatchedAskReply;

export interface AskDeliveryStore {
  get(group_id: string): Promise<AskDeliveryGroup | null>;
  put(group: AskDeliveryGroup): Promise<void>;
  groups(): Promise<AskDeliveryGroup[]>;
  delete(group_id: string): Promise<void>;
  putUnmatched(reply: UnmatchedAskReply): Promise<void>;
  unmatched(): Promise<UnmatchedAskReply[]>;
  dismissUnmatched(id: string, at: number): Promise<void>;
}

export const createAskDeliveryStore = (backing: Collection<AskDeliveryRecord>): AskDeliveryStore => ({
  async get(id) {
    const row = await backing.get(`group:${id}`);
    return row?.kind === 'group' ? structuredClone(row) : null;
  },
  put: group => backing.set(`group:${group.group_id}`, structuredClone(group)),
  async delete(id) { await backing.delete(`group:${id}`); },
  async groups() {
    return structuredClone((await backing.list()).filter((row): row is AskDeliveryGroup => row.kind === 'group'))
      .sort((a, b) => a.created_at - b.created_at || a.group_id.localeCompare(b.group_id));
  },
  putUnmatched: reply => backing.set(`reply:${reply.id}`, structuredClone(reply)),
  async unmatched() {
    return structuredClone((await backing.list()).filter((row): row is UnmatchedAskReply => row.kind === 'unmatched_reply'
      && row.dismissed_at === undefined)).sort((a, b) => b.created_at - a.created_at);
  },
  async dismissUnmatched(id, at) {
    const row = await backing.get(`reply:${id}`);
    if (row?.kind === 'unmatched_reply' && row.dismissed_at === undefined) await backing.set(`reply:${id}`, { ...row, dismissed_at: at });
  },
});

/** Host-authenticated transport identity, not fields supplied by an answer form. */
export type AskReplyOrigin = NonNullable<InboundReply['origin']>;

/** A channel receives one message containing independent questions. */
export interface AskDeliveryEnvelope {
  group_id: string;
  attempt_id: string;
  destination: AskDeliveryDestination;
  asks: readonly NewPendingAsk[];
  repeat: boolean;
  /** Preserve original item numbers while omitting buttons for items answered
   * during a quiet-hours hold or another destination's send. */
  closed_ask_ids?: readonly string[];
}

export interface AskDeliveryReceipt extends AskDeliveryEnvelope {
  provider_message_id?: string;
  presentation?: 'buttons' | 'text';
}
