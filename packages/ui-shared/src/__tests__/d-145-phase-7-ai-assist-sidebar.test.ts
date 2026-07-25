/** D-145 PA7 — AI-assist sidebar (stub) rendering.
 *
 *  Pin per § A.5.5:
 *    - Renders one button per `MAIL_COMPOSE_AI_ACTIONS` entry
 *    - Button data-action follows `mail-compose-ai-<kind>` shape
 *    - Stub marker (`data-stub="pa7"`) present on the wrapper
 *    - Submitting flag disables every action button
 *    - Static help text references Part B engine integration
 */

import { describe, expect, it } from 'vitest';

import { MAIL_COMPOSE_AI_ACTIONS } from '@recued/contracts';

import { renderAiAssistSidebar } from '../mail-compose/ai-assist-sidebar.js';

describe('D-145 PA7 — renderAiAssistSidebar', () => {
  it('renders one button per AI-assist action', () => {
    const html = renderAiAssistSidebar({ submitting: false });
    for (const action of MAIL_COMPOSE_AI_ACTIONS) {
      expect(html).toContain(`data-action="mail-compose-ai-${action}"`);
    }
  });

  it('marks the sidebar as a PA7 stub', () => {
    const html = renderAiAssistSidebar({ submitting: false });
    expect(html).toContain('data-stub="pa7"');
  });

  it('uses user-facing copy for the stub help text (no substrate-phase leak)', () => {
    const html = renderAiAssistSidebar({ submitting: false });
    // Codex P3 fold — pre-fold copy mentioned "Part B".
    expect(html).not.toMatch(/Part B/i);
  });

  it('exposes a compose action for create-mode (not just reply)', () => {
    const html = renderAiAssistSidebar({ submitting: false });
    expect(html).toContain('data-action="mail-compose-ai-compose"');
  });

  it('disables every button when submitting is true', () => {
    const html = renderAiAssistSidebar({ submitting: true });
    const buttonRegex =
      /<button[^>]*data-action="mail-compose-ai-[^"]+"[^>]*>/g;
    const matches = html.match(buttonRegex) ?? [];
    expect(matches.length).toBe(MAIL_COMPOSE_AI_ACTIONS.length);
    for (const button of matches) {
      expect(button).toContain('disabled');
      expect(button).toContain('aria-disabled="true"');
    }
  });

  it('does not disable buttons when submitting is false', () => {
    const html = renderAiAssistSidebar({ submitting: false });
    const buttonRegex =
      /<button[^>]*data-action="mail-compose-ai-[^"]+"[^>]*>/g;
    const matches = html.match(buttonRegex) ?? [];
    for (const button of matches) {
      expect(button).not.toContain(' disabled');
      expect(button).not.toContain('aria-disabled');
    }
  });
});
