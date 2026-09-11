/** Authenticated vendor ingress only: parse with the same Telegram transport
 * as normal delivery, retaining sender/conversation/message identity before
 * the generic notification adapter strips it. No model turn is involved. */
import { RpcError } from '@recued/contracts';
import { createTelegramTransport } from '@recued/transport';
import type { ComposeInboundAnswerDispatcherDeps } from './composition/bin/wire-inbound-answer-dispatcher.js';
import type { PreapprovalRepository } from './storage/preapproval-repository.js';

export const createPreapprovalTelegramIngress = (
  repository: PreapprovalRepository,
): NonNullable<ComposeInboundAnswerDispatcherDeps['preapprovalReview']> => {
  const transport = createTelegramTransport();
  return async (vendor, event) => {
    if (vendor !== 'telegram') return false;
    const choice = transport.parseInboundChoice(event.payload);
    if (!choice || !repository.getPrompt(choice.correlation_id)) return false;
    const conversationId = transport.parseCallbackConversationId(event.payload);
    const decision = choice.option_id;
    if (!conversationId || !choice.vendor_message_id || !event.id_value
      || (decision !== 'approve' && decision !== 'deny' && decision !== 'cancel')) {
      throw new RpcError('preapproval_invalid_proof', 'This callback has incomplete review identity.', 403);
    }
    await repository.decideTelegram({ ask_id: choice.correlation_id, connection_id: event.connection_name,
      owner_sender: choice.from, conversation_id: conversationId, vendor_message_id: choice.vendor_message_id,
      vendor_event_id: event.id_value, decision });
    return true;
  };
};
