/** Mail-compose AI rewrite controls. */

import { describe, expect, it } from 'vitest';

import { MAIL_COMPOSE_REWRITE_ACTIONS } from '@recued/contracts';

import { renderAiAssistSidebar } from '../mail-compose/ai-assist-sidebar.js';

describe('D-145 PA7 — renderAiAssistSidebar', () => {
  it('renders only the launch-safe existing-body transformations', () => {
    const html = renderAiAssistSidebar({ submitting: false });
    for (const action of MAIL_COMPOSE_REWRITE_ACTIONS) {
      expect(html).toContain(`data-action="mail-compose-ai-${action}"`);
    }
    expect(html).not.toContain('mail-compose-ai-compose"');
    expect(html).not.toContain('mail-compose-ai-draft-reply');
    expect(html).not.toContain('data-stub=');
    expect(html).not.toMatch(/coming soon/i);
    expect(html).toContain('review every change before sending');
  });

  it('disables every button when submitting is true', () => {
    const html = renderAiAssistSidebar({ submitting: true });
    const buttonRegex =
      /<button[^>]*data-action="mail-compose-ai-[^"]+"[^>]*>/g;
    const matches = html.match(buttonRegex) ?? [];
    expect(matches.length).toBe(MAIL_COMPOSE_REWRITE_ACTIONS.length);
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

  it('locks all transformations and marks the active one while rewriting', () => {
    const html = renderAiAssistSidebar({
      submitting: false,
      busyAction: 'rewrite-friendly',
    });
    const matches = html.match(
      /<button[^>]*data-action="mail-compose-ai-[^"]+"[^>]*>/g,
    ) ?? [];
    expect(matches).toHaveLength(MAIL_COMPOSE_REWRITE_ACTIONS.length);
    expect(matches.every((button) => button.includes('disabled'))).toBe(true);
    expect(html).toMatch(
      /data-action="mail-compose-ai-rewrite-friendly"[^>]*aria-busy="true"/,
    );
    expect(html).toContain('Rewriting…');
  });

  it('escapes errors and offers the host-owned one-step undo', () => {
    const html = renderAiAssistSidebar({
      submitting: false,
      error: '<bad rewrite>',
      canUndo: true,
    });
    expect(html).not.toContain('<bad rewrite>');
    expect(html).toContain('&lt;bad rewrite&gt;');
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-action="mail-compose-ai-undo"');
  });

  it('locks undo with the other draft mutations while sending', () => {
    const html = renderAiAssistSidebar({
      submitting: true,
      canUndo: true,
    });
    expect(html).toMatch(
      /data-action="mail-compose-ai-undo"[^>]*disabled[^>]*aria-disabled="true"/,
    );
  });
});
