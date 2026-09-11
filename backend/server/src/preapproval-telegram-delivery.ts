/** Telegram is an alternate surface for the SAME material review. It may
 * offer decision buttons only when the complete review fits the live adapter. */
import { RpcError, type PreapprovalReview } from '@recued/contracts';
import type { NotificationBlock } from '@recued/notification';
import { createTelegramTransport, telegramMessageFits, type TelegramTransportOptions } from '@recued/transport';
import { createRemoteCredentialResolver } from './composition/bin/wire-remote-channel.js';
import { resolveTelegramRecipient } from './composition/bin/wire-telegram-channel.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { KeyManager } from './key-manager.js';
import type { PreapprovalRepository } from './storage/preapproval-repository.js';

export const formatPreapprovalTelegramReview = (review: PreapprovalReview): { title: string; text: string } | null => {
  const at = (value: number) => new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full', timeStyle: 'long', timeZone: review.time_zone,
  }).format(new Date(value));
  const selected = new Set(review.selected_member_ids);
  const calls = review.members.filter(member => selected.has(member.member_id));
  const author = review.requested_through;
  const timing = review.scheduled_for === null
    ? review.activation.kind === 'next_auto_run' ? 'First qualifying automatic run after approval.'
      : 'First qualifying event after approval.'
    : at(review.scheduled_for);
  const lines = [review.recipe.display_name,
    `Requested through: ${author.display_name}${author.contract_id && author.contract_id !== author.display_name ? ` (${author.contract_id})` : ''}`,
    ...(author.credential_label ? [`Client: ${author.credential_label}`] : []),
    `Run once: ${timing}`, `Time zone: ${review.time_zone}`,
    `Decide by: ${at(review.decision_deadline)}`, `Start no later than: ${at(review.dispatch_deadline)}`,
    `Approve ${calls.length} operation${calls.length === 1 ? '' : 's'}, including the required reads listed below.`,
  ];
  for (const [index, call] of calls.entries()) {
    lines.push('', `${index + 1}. ${call.label}${call.parent_member_id ? ' (required by another operation)' : ''}`,
      `Operation: ${call.op_id}`, call.detail,
      ...(call.connection_id ? [`Connection: ${call.connection_id}`] : []),
      ...(call.account_id ? [`Account: ${call.account_id}`] : []),
      `Inputs: ${JSON.stringify(call.arguments)}`,
      ...(Object.keys(call.output).length ? [`Output destinations: ${JSON.stringify(call.output)}`] : []),
      ...call.resources.map(resource => `Resource: ${resource.key}; version ${resource.revision}; ${resource.content_hash}`),
      ...(call.conditional ? ['Runs only when its reviewed condition holds.'] : []));
  }
  if (review.coverage === 'partial') {
    lines.push('', 'Partial coverage: other calls retain their normal policy and may need another approval.',
      ...review.uncovered.map(call => `${call.op_id ?? 'Unresolved call'}: ${call.reason}`),
      ...review.members.filter(member => !selected.has(member.member_id)).map(member => `${member.label}: ${member.reason ?? 'Not selected'}`));
  }
  lines.push(...review.interaction_notes, '', 'Approving schedules or arms this one reviewed execution.');
  const message = { title: 'Review future execution', text: lines.join('\n') };
  return telegramMessageFits(message) ? message : null;
};

export const createPreapprovalTelegramDelivery = (deps: {
  repository: PreapprovalRepository;
  connectionStore: ConnectionStoreSqlite;
  block: Pick<NotificationBlock, 'getNotificationSettings'>;
  keys?: KeyManager;
  reviewLink(proposalId: string): string | null;
  /** Actual HTTP seam only; tests can record the real transport's requests. */
  transportOptions?: TelegramTransportOptions;
}) => {
  const transport = createTelegramTransport(deps.transportOptions);
  const resolveCredential = createRemoteCredentialResolver({ connectionStore: deps.connectionStore,
    vendor: 'telegram', resolveRecipient: resolveTelegramRecipient, ...(deps.keys ? { keys: deps.keys } : {}) });
  return {
    async deliver(proposalId: string): Promise<'disabled' | 'review' | 'link' | 'terminal'> {
      if (!(await deps.block.getNotificationSettings()).telegram.approval) return 'disabled';
      const credential = await resolveCredential();
      if (!credential?.expected_sender) return 'disabled';
      const prompt = deps.repository.reservePrompt(proposalId);
      if (!prompt) return 'terminal';
      const review = await deps.repository.reviewTelegram(proposalId, 'telegram', credential.expected_sender);
      const prior = deps.repository.listDeliveries(proposalId).find(delivery =>
        delivery.proposal_revision === prompt.proposal_revision && delivery.review_digest === prompt.review_digest
        && delivery.connection_id === 'telegram' && delivery.owner_sender === credential.expected_sender
        && delivery.conversation_id === credential.recipient);
      if (prior) return 'review';
      const priorLink = deps.repository.listReviewLinks(proposalId).find(delivery =>
        delivery.proposal_revision === prompt.proposal_revision && delivery.review_digest === prompt.review_digest
        && delivery.connection_id === 'telegram' && delivery.owner_sender === credential.expected_sender
        && delivery.conversation_id === credential.recipient);
      if (priorLink) return 'link';
      const message = formatPreapprovalTelegramReview(review);
      if (!message) {
        const link = deps.reviewLink(proposalId);
        const sent = await transport.send({ recipient: credential.recipient, token: credential.token,
          title: 'Review future execution', text: 'This review needs the full webclient. Open it to review and decide.',
          ...(link ? { link_url: link } : {}) });
        if (!sent.ok || !sent.vendor_message_id) throw new RpcError('preapproval_unresolved', 'The review link could not be delivered.', 503);
        deps.repository.recordReviewLink(prompt, { connection_id: 'telegram', owner_sender: credential.expected_sender,
          conversation_id: credential.recipient, vendor_message_id: sent.vendor_message_id });
        return 'link';
      }
      const sent = await transport.sendPrompt({ ...message, recipient: credential.recipient, token: credential.token,
        correlation_id: prompt.ask_id, options: [
          { id: 'approve', label: 'Approve once' }, { id: 'deny', label: 'Decline' }, { id: 'cancel', label: 'Cancel action' },
        ] });
      if (!sent.ok || !sent.vendor_message_id) throw new RpcError('preapproval_unresolved', 'The full review could not be delivered.', 503);
      try {
        deps.repository.recordDelivery(prompt, { connection_id: 'telegram', owner_sender: credential.expected_sender,
          conversation_id: credential.recipient, vendor_message_id: sent.vendor_message_id });
      } catch (error) {
        // The owner/selection may change while sendMessage is in flight.
        // Unticketed buttons cannot approve; retire the visible copy too.
        await transport.closePrompt({ recipient: credential.recipient, token: credential.token,
          vendor_message_id: sent.vendor_message_id, text: 'This review changed. Open the current review in Recued.' });
        throw error;
      }
      return 'review';
    },
    async close(proposalId: string): Promise<void> {
      const credential = await resolveCredential();
      if (!credential?.expected_sender) return;
      const prompts = deps.repository.listPrompts(proposalId);
      for (const delivery of deps.repository.listDeliveries(proposalId)) {
        if (delivery.connection_id !== 'telegram' || delivery.owner_sender !== credential.expected_sender
          || delivery.conversation_id !== credential.recipient) continue;
        const prompt = prompts.find(item => item.proposal_revision === delivery.proposal_revision && item.review_digest === delivery.review_digest);
        if (!prompt || deps.repository.projectPrompt(prompt.ask_id, { proposal_id: proposalId,
          proposal_revision: prompt.proposal_revision, review_digest: prompt.review_digest }).kind === 'pending') continue;
        const result = await transport.closePrompt({ recipient: credential.recipient, token: credential.token,
          vendor_message_id: delivery.vendor_message_id, text: 'This review is closed. Open Recued for its decision and execution status.' });
        if (!result.ok) throw new RpcError('preapproval_unresolved', 'The remote review could not be closed.', 503);
      }
    },
  };
};
