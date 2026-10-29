/** Mail-compose AI rewrite controls. */

import { describe, expect, it } from 'vitest';

import { MAIL_COMPOSE_REWRITE_ACTIONS } from '@recued/contracts';

import { renderAiAssistSidebar } from '../mail-compose/ai-assist-sidebar.js';

describe('D-145 PA7 — renderAiAssistSidebar', () => {
  it('offers drafting and existing-body transformations in the same composer', () => {
    const html = renderAiAssistSidebar({ submitting: false });
    for (const action of MAIL_COMPOSE_REWRITE_ACTIONS) {
      expect(html).toContain(`data-action="mail-compose-ai-${action}"`);
    }
    expect(html).toContain('data-mail-compose-ai-brief');
    expect(html).toContain('data-action="mail-compose-ai-draft"');
  });

  it('disables every button when submitting is true', () => {
    const html = renderAiAssistSidebar({ submitting: true });
    const buttonRegex =
      /<button[^>]*data-action="mail-compose-ai-[^"]+"[^>]*>/g;
    const matches = html.match(buttonRegex) ?? [];
    expect(matches.some(button => button.includes('mail-compose-ai-draft'))).toBe(true);
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
    expect(matches.some(button => button.includes('mail-compose-ai-draft'))).toBe(true);
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
