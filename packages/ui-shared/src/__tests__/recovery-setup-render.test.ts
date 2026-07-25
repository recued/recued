/** Recovery setup renderer tests — optional pair fields gating, and
 *  the existing stage walk smoke.
 *
 *  Ported from `apps/extension/src/recovery/__tests__/render.test.ts`
 *  at `c222acac^`. */

import { describe, it, expect } from 'vitest';
import {
  renderRecoverySetup,
  initialRecoverySetupSlice,
  pairServerUrlChanged,
  pairServerCodeChanged,
  type RecoverySetupSlice,
} from '../account/recovery-setup.js';

const mkSlice = (over: Partial<RecoverySetupSlice> = {}): RecoverySetupSlice => ({
  ...initialRecoverySetupSlice(),
  ...over,
});

describe('renderRecoverySetup — stages', () => {
  it('idle renders the kickoff CTA', () => {
    const html = renderRecoverySetup(mkSlice());
    expect(html).toContain('Set up recovery key');
    expect(html).toContain('data-action="recovery-setup-start"');
  });

  it('writing renders the generated key + ack button', () => {
    const html = renderRecoverySetup(mkSlice({
      stage: 'writing',
      generatedKey: 'word1 word2 word3',
    }));
    expect(html).toContain('Write down this recovery key');
    expect(html).toContain('word1');
    expect(html).toContain('data-action="recovery-setup-ack-written"');
  });

  it('challenging renders the 24-slot grid', () => {
    const html = renderRecoverySetup(mkSlice({ stage: 'challenging' }));
    expect(html).toContain('data-recovery-field="challenge-word"');
    expect(html).toContain('data-action="recovery-setup-submit"');
  });

  it('wrapping renders the spinner with check-specific copy', () => {
    const html = renderRecoverySetup(mkSlice({ stage: 'wrapping' }));
    expect(html).toContain('Sealing your recovery check');
  });

  it('finalizing renders the spinner with follow-on copy', () => {
    const html = renderRecoverySetup(mkSlice({ stage: 'finalizing' }));
    expect(html).toContain('Encrypting + finalizing');
  });

  it('done renders the success panel when no error is set', () => {
    const html = renderRecoverySetup(mkSlice({ stage: 'done' }));
    expect(html).toContain('Recovery key saved');
    expect(html).not.toContain('follow-up failed');
  });

  it('done renders the warning variant when error is set (saved-but-follow-up-failed)', () => {
    const html = renderRecoverySetup(mkSlice({
      stage: 'done',
      error: 'Setup saved, but the follow-up step failed: pair failed',
    }));
    expect(html).toContain('Recovery key saved — follow-up failed');
    expect(html).toContain('pair failed');
    expect(html).toContain('safely stored on this device');
  });
});

describe('renderRecoverySetup — optional pair fields', () => {
  it('challenging: optional pair fields hidden by default', () => {
    const html = renderRecoverySetup(mkSlice({ stage: 'challenging' }));
    expect(html).not.toContain('data-recovery-pair-field');
    expect(html).not.toContain('Pair a server now');
  });

  it('challenging with includeOptionalPair=true renders the disclosure', () => {
    const html = renderRecoverySetup(
      mkSlice({ stage: 'challenging' }),
      { includeOptionalPair: true },
    );
    expect(html).toContain('Pair a server now (optional)');
    expect(html).toContain('data-recovery-pair-field="server-url"');
    expect(html).toContain('data-recovery-pair-field="server-code"');
    expect(html).toContain('placeholder="http://localhost:7717"');
    expect(html).not.toContain('placeholder="http://localhost:3001"');
  });

  it('disclosure is closed by default when both pair fields are empty', () => {
    const html = renderRecoverySetup(
      mkSlice({ stage: 'challenging' }),
      { includeOptionalPair: true },
    );
    // <details> without `open` attribute renders collapsed.
    expect(html).toMatch(/<details class="rx-recovery-optional-pair" >/);
  });

  it('disclosure auto-opens when either pair field has content', () => {
    const html = renderRecoverySetup(
      mkSlice({
        stage: 'challenging',
        pairServerUrl: 'http://localhost:3001',
      }),
      { includeOptionalPair: true },
    );
    expect(html).toMatch(/<details class="rx-recovery-optional-pair" open>/);
  });

  it('pair fields preserve typed values across renders', () => {
    const html = renderRecoverySetup(
      mkSlice({
        stage: 'challenging',
        pairServerUrl: 'http://my-nas.local:3001',
        pairServerCode: 'XYZ12345',
      }),
      { includeOptionalPair: true },
    );
    expect(html).toContain('value="http://my-nas.local:3001"');
    expect(html).toContain('value="XYZ12345"');
  });

  it('non-challenging stages ignore includeOptionalPair (no pair fields shown)', () => {
    const writing = renderRecoverySetup(
      mkSlice({ stage: 'writing', generatedKey: 'a b c' }),
      { includeOptionalPair: true },
    );
    expect(writing).not.toContain('data-recovery-pair-field');

    const done = renderRecoverySetup(
      mkSlice({ stage: 'done' }),
      { includeOptionalPair: true },
    );
    expect(done).not.toContain('data-recovery-pair-field');
  });
});

describe('renderRecoverySetup — pair-field reducers', () => {
  it('pairServerUrlChanged updates the slice without touching other fields', () => {
    const patch = pairServerUrlChanged('http://localhost:3001');
    expect(patch.pairServerUrl).toBe('http://localhost:3001');
    expect(patch.error).toBeNull();
  });

  it('pairServerCodeChanged updates the slice', () => {
    const patch = pairServerCodeChanged('ABC12345');
    expect(patch.pairServerCode).toBe('ABC12345');
    expect(patch.error).toBeNull();
  });
});
