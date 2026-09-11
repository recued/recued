/** Host capabilities for notifications whose answer is a projection of a
 * separate durable owner decision. JSON handler payloads carry no authority. */
import { PREAPPROVAL_NOTIFICATION_HANDLER, RpcError } from '@recued/contracts';
import { ASK_BODY_MAX, type Answer, type AskExtras, type AskHandlerRef, type AskOption,
  type ChannelName, type ChannelSelector, type NotificationMessage, type PendingAsk } from './types.js';
import type { NotificationBlock } from './index.js';
import type { Channel } from './channels/channel.js';

type ProtectedKind = typeof PREAPPROVAL_NOTIFICATION_HANDLER;
export const isProtectedAskKind = (kind: string): kind is ProtectedKind => kind === PREAPPROVAL_NOTIFICATION_HANDLER;

export interface ProtectedAskAuthority {
  /** Restrict interactive delivery to surfaces with a wired trusted review
   * path. Other configured channels may still receive passive awareness. */
  canDeliverTo(channel: Channel): boolean;
  /** Validate the reserved id and immutable payload against the actual
   * proposal row before creating or redelivering a prompt. */
  validatePrompt(askId: string, payload: Record<string, unknown>): Promise<void>;
  /** Resolve the canonical decision from storage. No caller answer/proof is
   * accepted here. Null means the prompt must stay open. */
  resolveProjection(ask: PendingAsk): Promise<
    { kind: 'decision'; decision_id: string; answer: Answer; via: ChannelName }
    | { kind: 'stopped' }
    | null
  >;
}
export interface ProtectedAskController {
  ask(message: NotificationMessage, options: readonly AskOption[], payload: Record<string, unknown>,
    channels: ChannelSelector, extras: AskExtras & { reserved_ask_id: string }): Promise<{ ask_id: string }>;
  project(askId: string): Promise<'pending' | 'settled'>;
}
interface ProtectedAskHost {
  registered: Set<ProtectedKind>;
  project(askId: string, kind: ProtectedKind, authority: ProtectedAskAuthority): Promise<'pending' | 'settled'>;
}
const hosts = new WeakMap<NotificationBlock, ProtectedAskHost>();
const authorizations = new WeakMap<AskHandlerRef, { block: NotificationBlock; authority: ProtectedAskAuthority }>();

/** Package-private installation; not exported from the notification entry. */
export const installProtectedAskHost = (block: NotificationBlock, host: Omit<ProtectedAskHost, 'registered'>): void => {
  hosts.set(block, { ...host, registered: new Set() });
};
export const requireProtectedAskCreation = async (block: NotificationBlock, handler: AskHandlerRef, askId: string): Promise<ProtectedAskAuthority | undefined> => {
  if (!isProtectedAskKind(handler.kind)) return undefined;
  const authorization = authorizations.get(handler);
  if (!authorization || authorization.block !== block) {
    throw new RpcError('preapproval_invalid_proof', 'This review prompt requires its durable pre-approval proposal.', 403);
  }
  await authorization.authority.validatePrompt(askId, handler.payload);
  return authorization.authority;
};

/** Called by host composition once per block. The returned capability stays
 * in the host service; it is not a kernel dispatcher, RPC or notification DTO. */
export const createProtectedAskController = (
  block: NotificationBlock, kind: ProtectedKind, authority: ProtectedAskAuthority,
): ProtectedAskController => {
  const host = hosts.get(block);
  if (!host || !isProtectedAskKind(kind) || host.registered.has(kind)) throw new Error('Protected notification controller is unavailable or already registered.');
  host.registered.add(kind);
  return {
    async ask(message, options, payload, channels, extras) {
      if (!extras.reserved_ask_id || (extras.body !== undefined && extras.body.length > ASK_BODY_MAX)) {
        throw new Error('The protected review must have a reserved identity and fit without truncation.');
      }
      const handler: AskHandlerRef = { kind, payload };
      authorizations.set(handler, { block, authority });
      return block.ask(message, options, handler, channels, extras);
    },
    project: askId => host.project(askId, kind, authority),
  };
};
