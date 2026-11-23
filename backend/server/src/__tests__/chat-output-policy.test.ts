import { expect, it } from 'vitest';
import { CHAT_MAIN_TURN_SYSTEM_PROMPT, composeChatMainTurnSystemPrompt } from '../chat-turn-executor.js';
import { BROWSER_NEXT_ACTION_GUIDANCE, CHAT_OUTPUT_SHAPE, chatThinkingOffPrompt, browserActionContext } from '../chat-output-policy.js';
import { MAIL_WORK_OUTPUT_SHAPE } from '../mail-work-investigation-guidance.js';
import { MAIL_WORK_PLAN_OUTPUT_SHAPE } from '../mail-work-chat-plan-guidance.js';

it('removes full internal reasoning from the real chat prompt while preserving the remaining envelope and catalog modes', () => {
  for (const mode of ['full', 'index', 'lean-core'] as const) {
    const original = composeChatMainTurnSystemPrompt(mode);
    const off = chatThinkingOffPrompt(original, MAIL_WORK_OUTPUT_SHAPE);
    expect(original).toContain(CHAT_OUTPUT_SHAPE);
    expect(off).not.toContain('work the answer out here FIRST');
    expect(off).not.toContain('Show any arithmetic step by step');
    expect(off).not.toMatch(/^  "reasoning":/m);
    expect(off).toContain('Omit the "reasoning" field');
    for (const field of ['response', 'events', 'tool_calls', 'nothing_outstanding']) expect(off).toContain(`"${field}"`);
    expect(off).not.toContain(BROWSER_NEXT_ACTION_GUIDANCE);
  }
  expect(composeChatMainTurnSystemPrompt('full')).toBe(CHAT_MAIN_TURN_SYSTEM_PROMPT);
});

it('also removes the legacy mail-work reasoning request and leaves the current plan schema intact', () => {
  const off = chatThinkingOffPrompt(MAIL_WORK_OUTPUT_SHAPE, MAIL_WORK_OUTPUT_SHAPE);
  expect(off).not.toMatch(/^  "reasoning":/m);
  expect(off).not.toContain('one short sentence explaining');
  expect(chatThinkingOffPrompt(MAIL_WORK_PLAN_OUTPUT_SHAPE, MAIL_WORK_OUTPUT_SHAPE)).toBe(MAIL_WORK_PLAN_OUTPUT_SHAPE);
  const evidence = 'Owner text says: "reasoning": "keep this evidence"';
  expect(chatThinkingOffPrompt(evidence, MAIL_WORK_OUTPUT_SHAPE, true)).toBe(evidence);
});

it('bounds browser output at an observation only for host-identified browser turns', () => {
  expect(browserActionContext([{}], [])).toBe(true);
  expect(browserActionContext([], [{ tool_name: 'browser-toolkit/act-on-web-page' }])).toBe(true);
  expect(browserActionContext([], [{ tool_name: 'recued-core/read-web-table' }])).toBe(true);
  expect(browserActionContext([], [{ tool_name: 'recued-core/read-web-element' }])).toBe(true);
  expect(browserActionContext([], [{ tool_name: 'recued-core/type-into-web-page' }])).toBe(true);
  expect(browserActionContext([], [{ tool_name: 'mail/send' }])).toBe(false);
  expect(browserActionContext(undefined, undefined)).toBe(false);
  const off = chatThinkingOffPrompt(CHAT_MAIN_TURN_SYSTEM_PROMPT, MAIL_WORK_OUTPUT_SHAPE, true);
  expect(off).toContain(BROWSER_NEXT_ACTION_GUIDANCE);
  expect(off).toContain('after navigation or form submission');
  expect(off).toContain('Return that observation before planning');
});
