/** Semantic hierarchy over Chat's existing typed durable route grammar. */

import {
  hierarchicalAddress,
  hierarchicalAddressFromHash,
  hierarchicalLevel,
  type HierarchicalAddress,
} from '../shell/hierarchical-navigation.js';
import {
  parseShellRoute,
  serializeChatAnswerAddress,
  serializeChatPlanAddress,
  serializeChatSessionAddress,
  serializeShellRoute,
  type ChatAnswerAddress,
  type ChatPlanAddress,
  type ChatSessionAddress,
} from '../shell/route.js';

export const chatHomeAddress = (): HierarchicalAddress =>
  hierarchicalAddress('chat');

export const chatDraftAddress = (
  mode: 'new' | 'start' = 'new',
): HierarchicalAddress => hierarchicalAddress(
  'chat',
  hierarchicalLevel(`chat-draft:${mode}`, mode),
);

export const chatSessionNavigationAddress = (
  address: ChatSessionAddress,
): HierarchicalAddress => hierarchicalAddressFromHash(
  'chat',
  serializeChatSessionAddress(address),
  hierarchicalLevel(
    `chat-session:${address.sessionId}`,
    'session',
    address.sessionId,
  ),
);

export const chatAnswerNavigationAddress = (
  address: ChatAnswerAddress,
): HierarchicalAddress => hierarchicalAddressFromHash(
  'chat',
  serializeChatAnswerAddress(address),
  hierarchicalLevel(
    `chat-session:${address.sessionId}`,
    'session',
    address.sessionId,
  ),
  hierarchicalLevel(`chat-answer:${address.messageId}`, 'answer', address.messageId),
);

export const chatPlanNavigationAddress = (
  address: ChatPlanAddress,
): HierarchicalAddress => hierarchicalAddressFromHash(
  'chat',
  serializeChatPlanAddress(address),
  hierarchicalLevel(
    `chat-session:${address.sessionId}`,
    'session',
    address.sessionId,
  ),
  hierarchicalLevel(`chat-plan:${address.planId}`, 'plan', address.planId),
  ...(address.messageId === undefined
    ? []
    : [hierarchicalLevel(
        `chat-answer-fallback:${address.messageId}`,
        'answer',
        address.messageId,
      )]),
  ...(address.dataVerification === undefined
    ? []
    : [hierarchicalLevel(
        `chat-verification:${address.dataVerification.runId}`,
        'verification',
        address.dataVerification.result,
        'run',
        address.dataVerification.runId,
        ...(address.dataVerification.relationship === undefined
          ? []
          : ['relationship', address.dataVerification.relationship]),
      )]),
);

/** Convert every current Chat hash to the shared navigation descriptor. Typed
 * session/answer/plan routes retain their meaningful levels; setup and source
 * handoffs remain one opaque, non-executable place. */
export const chatHierarchicalAddress = (hash: string): HierarchicalAddress => {
  const route = parseShellRoute(hash);
  if (route.surface !== 'chat') {
    throw new Error(`chatHierarchicalAddress: expected chat, received ${route.surface}`);
  }
  if (route.segments.length === 0) return chatHomeAddress();
  if (
    route.segments[0] === 'session'
    && typeof route.segments[1] === 'string'
  ) {
    const sessionId = route.segments[1];
    if (
      route.segments[2] === 'answer'
      && typeof route.segments[3] === 'string'
    ) {
      return chatAnswerNavigationAddress({
        sessionId,
        messageId: route.segments[3],
      });
    }
    if (
      route.segments[2] === 'plan'
      && typeof route.segments[3] === 'string'
    ) {
      // Preserve richer plan tails exactly even if this adapter cannot safely
      // reinterpret a future optional context field.
      return hierarchicalAddressFromHash(
        'chat',
        hash,
        hierarchicalLevel(`chat-session:${sessionId}`, 'session', sessionId),
        hierarchicalLevel(`chat-plan:${route.segments[3]}`, 'plan', route.segments[3]),
      );
    }
    return chatSessionNavigationAddress({ sessionId });
  }
  if (route.segments[0] === 'new' || route.segments[0] === 'start') {
    return chatDraftAddress(route.segments[0]);
  }
  return hierarchicalAddressFromHash(
    'chat',
    serializeShellRoute('chat', ...route.segments),
    hierarchicalLevel(
      `chat-view:${route.segments[0]}`,
      ...route.segments,
    ),
  );
};
