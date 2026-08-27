import { describe, expect, it } from 'vitest';

import {
  chatAnswerNavigationAddress,
  chatHierarchicalAddress,
  chatPlanNavigationAddress,
  chatSessionNavigationAddress,
} from '../chat-navigation.js';

describe('Chat hierarchical navigation contract', () => {
  it('models history -> session -> focused answer', () => {
    expect(chatSessionNavigationAddress({ sessionId: 'chat/1' }).hash)
      .toBe('#chat/session/chat%2F1');
    expect(chatAnswerNavigationAddress({
      sessionId: 'chat/1',
      messageId: 'answer 2',
    }).levels.map((level) => level.key)).toEqual([
      'chat-session:chat/1',
      'chat-answer:answer 2',
    ]);
  });

  it('keeps plan fallback and verification context in the canonical hash', () => {
    const address = chatPlanNavigationAddress({
      sessionId: 'chat-1',
      planId: 'plan-1',
      messageId: 'answer-1',
      dataVerification: {
        result: 'reviewed',
        runId: 'run-1',
        relationship: 'action',
      },
    });
    expect(address.hash).toBe(
      '#chat/session/chat-1/plan/plan-1/answer/answer-1/'
      + 'verification/reviewed/run/run-1/relationship/action',
    );
  });

  it('projects current durable and opaque Chat routes without executing them', () => {
    expect(chatHierarchicalAddress('#chat/session/c-1/answer/a-1').levels)
      .toHaveLength(2);
    expect(chatHierarchicalAddress('#chat/source/mail/google/work').levels)
      .toHaveLength(1);
    expect(() => chatHierarchicalAddress('#logs/run-1')).toThrow(/expected chat/);
  });
});
