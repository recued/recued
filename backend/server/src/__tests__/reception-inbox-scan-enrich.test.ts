/** D-173 P5 (scan-gate part B) — `withLiveAttachmentScanStatus`: a pure wrapper
 *  that overrides a drop attachment's `scan_status` with the LIVE
 *  data.file.received verdict (the ClamAV pack writes it). Extracted from the
 *  boot composer so the enrichment is unit-tested without the heavy
 *  `composeReceptionInboxDeps` setup. */
import { describe, expect, it } from 'vitest';

import {
  withLiveAttachmentScanStatus,
  type ResolveInboxSource,
  type ResolvedInboxSource,
} from '../reception-inbox-handler.js';

// The wrapper ignores `held`; a dummy cast is fine for the pure-logic test.
const HELD = {} as Parameters<ResolveInboxSource>[0];

const withAttachment = (
  scan_status: 'pending' | 'clean' | 'flagged' | 'unscanned',
): ResolvedInboxSource => ({
  top_tier_kind: 'commitment',
  source: { kind: 'drop_link', record_ref: 'cp-1' },
  args: {},
  preview: { title: 'Incoming request' },
  proposed_action: 'Run x',
  attachment: {
    file_id: 'file:abc',
    filename: 'doc.pdf',
    mime_type: 'application/pdf',
    size: 5,
    scan_status,
  },
});

describe('withLiveAttachmentScanStatus', () => {
  it('overrides a drop attachment scan_status with the live verdict (reading by file_id)', () => {
    const base: ResolveInboxSource = () => withAttachment('unscanned');
    const wrapped = withLiveAttachmentScanStatus(base, (file_id) => {
      expect(file_id).toBe('file:abc');
      return 'flagged';
    });
    expect(wrapped(HELD)?.attachment?.scan_status).toBe('flagged');
  });

  it('returns the base resolver UNCHANGED (identity) when no reader is wired', () => {
    const base: ResolveInboxSource = () => withAttachment('unscanned');
    expect(withLiveAttachmentScanStatus(base, undefined)).toBe(base);
  });

  it('leaves scan_status at the floor when the live read returns undefined (vanished record)', () => {
    const base: ResolveInboxSource = () => withAttachment('unscanned');
    const out = withLiveAttachmentScanStatus(base, () => undefined)(HELD);
    expect(out?.attachment?.scan_status).toBe('unscanned');
  });

  it('passes a result with NO attachment through untouched, never consulting the reader', () => {
    const noAtt: ResolvedInboxSource = {
      top_tier_kind: 'commitment',
      source: { kind: 'intake_form', record_ref: 'cp' },
      args: {},
      preview: { title: 'x' },
      proposed_action: 'y',
    };
    let called = false;
    const out = withLiveAttachmentScanStatus(
      () => noAtt,
      () => { called = true; return 'clean'; },
    )(HELD);
    expect(out).toBe(noAtt);
    expect(called).toBe(false);
  });

  it('passes a null base result through', () => {
    const out = withLiveAttachmentScanStatus(() => null, () => 'clean')(HELD);
    expect(out).toBeNull();
  });

  it('does not mutate the base attachment object (returns a fresh copy)', () => {
    const original = withAttachment('unscanned');
    const out = withLiveAttachmentScanStatus(() => original, () => 'clean')(HELD);
    expect(out?.attachment?.scan_status).toBe('clean');
    expect(original.attachment?.scan_status).toBe('unscanned');
  });
});
