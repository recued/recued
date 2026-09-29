/**
 * D-315 §4.3 — one model call through the chat's privacy layer, outside a chat
 * turn. The owner's standard for background AI is the chat's (ruling 30, and
 * D-316): *"the same full alias like passing a mail to chat"*.
 *
 * It is the chat's own seam, as the llm_gateway uses it for a stateless call
 * (`createPiiEgressPlanForSession` + `wrapExecuteAiCallForPii`):
 *   - the whole packet is aliased as a turn's is — a tool result against the
 *     whole warehouse's contacts, a record's tagged fields, the owner's prose;
 *   - on a ledger of its own, never a chat session's, so one call is one
 *     numbering and nothing crosses into a conversation;
 *   - the answer is mapped back before the caller sees it.
 *
 * ⛔ Whatever fails before the model is called is the privacy layer's, and is
 * raised as `ChatPiiPrivacyError`: no call was made, and the caller must be
 * able to say so rather than blame the model.
 */

import { randomUUID } from 'node:crypto';

import { piiEgress } from '@recued/gateway';

import {
  ChatPiiPrivacyError,
  createPiiEgressPlanForSession,
  wrapExecuteAiCallForPii,
} from './chat-pii-egress.js';
import type { ExecuteChatAiCall } from './chat-orchestrator.js';
import type { RecallResolver } from './chat-recall-index.js';

export interface PrivateAiCallDeps {
  /** The model call itself (`executeLLM` with the server's config). */
  readonly execute: ExecuteChatAiCall;
  /** The live `MetaField.privacy` resolver the chat turn uses. */
  readonly resolver: piiEgress.FieldPrivacyResolver;
  /** The whole-warehouse contact index a tool result is aliased against. */
  readonly getContactKnownValueIndex?: () => RecallResolver | undefined;
}

export const createPrivateAiCall = (deps: PrivateAiCallDeps): ExecuteChatAiCall =>
  async (manifest, input, opts) => {
    const plan = createPiiEgressPlanForSession(
      {
        ledgerStore: piiEgress.createSessionLedgerStore(),
        resolver: deps.resolver,
        ...(deps.getContactKnownValueIndex !== undefined
          ? { getContactKnownValueIndex: deps.getContactKnownValueIndex }
          : {}),
      },
      `private-ai:${randomUUID()}`,
      'chat',
    );
    let called = false;
    const real: ExecuteChatAiCall = (m, i, o) => {
      called = true;
      return deps.execute(m, i, o);
    };
    try {
      return await wrapExecuteAiCallForPii(real, plan)(manifest, input, opts);
    } catch (error) {
      if (!called && !(error instanceof ChatPiiPrivacyError)) {
        throw new ChatPiiPrivacyError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  };
