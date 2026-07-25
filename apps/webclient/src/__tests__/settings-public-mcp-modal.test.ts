/** D-148 W3.8 — settings: /mcp.public acknowledgement modal. */

import { describe, expect, it } from 'vitest';
import { PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE } from '@recued/contracts';
import {
  PUBLIC_MCP_MODAL_COPY,
  closePublicMcpModal,
  failPublicMcpModal,
  isPublicMcpAcknowledgementActive,
  openPublicMcpModal,
  submitPublicMcpModal,
  typePublicMcpPhrase,
  type PublicMcpModalState,
} from '../settings/public-mcp-modal.js';

describe('D-148 W3.8 — public-mcp modal', () => {
  it('opens in idle and transitions to open(acknowledge) with phrase invalid', () => {
    const state = openPublicMcpModal('acknowledge');
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.mode).toBe('acknowledge');
      expect(state.phrase_valid).toBe(false);
      expect(state.typed_phrase).toBe('');
    }
  });

  it('opens in revoke mode with phrase_valid=true (no phrase needed)', () => {
    const state = openPublicMcpModal('revoke');
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.mode).toBe('revoke');
      expect(state.phrase_valid).toBe(true);
    }
  });

  it('typing the wrong phrase keeps phrase_valid=false', () => {
    let state: PublicMcpModalState = openPublicMcpModal('acknowledge');
    state = typePublicMcpPhrase(state, 'wrong words');
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.typed_phrase).toBe('wrong words');
      expect(state.phrase_valid).toBe(false);
    }
  });

  it('typing the canonical phrase flips phrase_valid=true', () => {
    let state: PublicMcpModalState = openPublicMcpModal('acknowledge');
    state = typePublicMcpPhrase(state, PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.phrase_valid).toBe(true);
    }
  });

  it('phrase validation is whitespace-insensitive at edges', () => {
    let state: PublicMcpModalState = openPublicMcpModal('acknowledge');
    state = typePublicMcpPhrase(state, `   ${PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE}   `);
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.phrase_valid).toBe(true);
    }
  });

  it('submit fails when phrase missing', () => {
    const state = openPublicMcpModal('acknowledge');
    const r = submitPublicMcpModal(state);
    expect(r).toEqual({ ok: false, error: 'phrase_required' });
  });

  it('submit fails when phrase wrong', () => {
    let state: PublicMcpModalState = openPublicMcpModal('acknowledge');
    state = typePublicMcpPhrase(state, 'enable PUBLIC mcp');
    const r = submitPublicMcpModal(state);
    expect(r).toEqual({ ok: false, error: 'phrase_mismatch' });
  });

  it('submit succeeds with canonical phrase + builds dispatch', () => {
    let state: PublicMcpModalState = openPublicMcpModal('acknowledge');
    state = typePublicMcpPhrase(state, PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    const r = submitPublicMcpModal(state, { reason: 'unit-test' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dispatch.op).toBe('exposure.set_public_mcp_acknowledgement');
      expect(r.dispatch.acknowledge).toBe(true);
      expect(r.dispatch.free_text_confirmation).toBe(PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
      expect(r.dispatch.reason).toBe('unit-test');
      expect(r.next.kind).toBe('submitting');
    }
  });

  it('submit (revoke) builds the demotion dispatch without phrase', () => {
    const state = openPublicMcpModal('revoke');
    const r = submitPublicMcpModal(state);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dispatch.acknowledge).toBe(false);
      expect(r.dispatch.free_text_confirmation).toBeUndefined();
    }
  });

  it('failPublicMcpModal moves state to error preserving typed phrase', () => {
    let state: PublicMcpModalState = openPublicMcpModal('acknowledge');
    state = typePublicMcpPhrase(state, 'something');
    const submitOut = submitPublicMcpModal(state);
    expect(submitOut.ok).toBe(false);
    state = failPublicMcpModal(state, 'public_mcp_phrase_mismatch');
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.error).toBe('public_mcp_phrase_mismatch');
      expect(state.typed_phrase).toBe('something');
    }
  });

  it('closePublicMcpModal returns idle', () => {
    expect(closePublicMcpModal()).toEqual({ kind: 'idle' });
  });

  it('Codex P2 #2 — typing on error state transitions back to open + re-validates', () => {
    let state: PublicMcpModalState = openPublicMcpModal('acknowledge');
    state = typePublicMcpPhrase(state, 'wrong');
    state = failPublicMcpModal(state, 'public_mcp_phrase_mismatch');
    expect(state.kind).toBe('error');
    state = typePublicMcpPhrase(state, PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.phrase_valid).toBe(true);
      expect(state.typed_phrase).toBe(PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    }
  });

  it('Codex P2 #2 — retry flow: type → fail → re-type → submit succeeds', () => {
    let state: PublicMcpModalState = openPublicMcpModal('acknowledge');
    state = typePublicMcpPhrase(state, 'enable PUBLIC mcp');
    const first = submitPublicMcpModal(state);
    expect(first.ok).toBe(false);
    state = failPublicMcpModal(state, 'public_mcp_phrase_mismatch');
    state = typePublicMcpPhrase(state, PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    const second = submitPublicMcpModal(state);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.dispatch.free_text_confirmation).toBe(PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    }
  });

  it('isPublicMcpAcknowledgementActive returns true only on well-formed ack', () => {
    expect(
      isPublicMcpAcknowledgementActive({
        acknowledged: true,
        free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
      }),
    ).toBe(true);
    expect(
      isPublicMcpAcknowledgementActive({
        acknowledged: true,
      } as never),
    ).toBe(false);
    expect(isPublicMcpAcknowledgementActive({ acknowledged: false })).toBe(false);
  });

  it('copy contains the canonical phrase prompt for acknowledge mode', () => {
    expect(PUBLIC_MCP_MODAL_COPY.acknowledge.phrase_prompt).toContain(
      PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
    );
    expect(PUBLIC_MCP_MODAL_COPY.acknowledge.bullets.length).toBeGreaterThanOrEqual(4);
  });
});
