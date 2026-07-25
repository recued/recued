/** Ack-before-run flip — `engine.turn_failed` enrollment pins.
 *
 *  The flip resolves the `chat.send` rpc at the turn's commit point,
 *  so a post-accept shell throw can no longer reject the rpc; this
 *  failure-class event is the surviving user-visible signal (emitted
 *  by `handleSend`'s completion watcher; the PB7 `TurnFailureNotice`
 *  projection paints it). Pins the full taxonomy enrollment so a
 *  refactor can't silently drop the kind from any one map. */

import { describe, expect, it } from 'vitest';
import {
  TRANSPARENCY_EVENT_KINDS,
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  classForTransparencyEventKind,
  isTransparencyEventKind,
  validateTransparencyEvent,
  defaultRedactionForKind,
  renderTransparencyTemplate,
  applyVisibilityPolicy,
  withEnabled,
  type TransparencyEvent,
} from '../index.js';

const event: TransparencyEvent = { kind: 'engine.turn_failed' };

describe('engine.turn_failed — taxonomy enrollment', () => {
  it('is a registered kind with failure class', () => {
    expect(TRANSPARENCY_EVENT_KINDS).toContain('engine.turn_failed');
    expect(isTransparencyEventKind('engine.turn_failed')).toBe(true);
    expect(classForTransparencyEventKind('engine.turn_failed')).toBe('failure');
  });

  it('validates with a bare payload — the closed kind is the whole wire story', () => {
    expect(validateTransparencyEvent({ kind: 'engine.turn_failed' })).toEqual([]);
  });

  it('defaults to redaction tier none (nothing to redact)', () => {
    expect(defaultRedactionForKind('engine.turn_failed')).toBe('none');
  });

  it('templates the dual-audience failure copy', () => {
    expect(renderTransparencyTemplate(event)).toBe(
      'this turn failed before completing — your message was saved; send it again to retry',
    );
  });

  it('bypasses a master-off visibility policy (§ B.8.2 user-must-see)', () => {
    const masterOff = withEnabled(DEFAULT_TRANSPARENCY_STREAM_SETTINGS, false);
    expect(applyVisibilityPolicy(event, 'none', masterOff)).toBe('none');
  });
});
