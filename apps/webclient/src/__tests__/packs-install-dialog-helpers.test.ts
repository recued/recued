/** Packs R22 R2 — the extracted install-dialog module's exported helpers.
 *
 *  The dialog RENDER is covered end-to-end through the panel suites (which
 *  drive it via `mountPacksPanel` exactly as production does); this file
 *  pins the two pure helpers that became exported API with the extraction. */

import { describe, expect, it } from 'vitest';

import {
  installFailureCopy,
  resolveInstallDialogAccess,
} from '../settings/packs-install-dialog.js';
import type { InstallGrantPickerModel } from '../settings/install-grant-picker.js';

describe('installFailureCopy', () => {
  it('maps every known engine failure code to its copy', () => {
    expect(installFailureCopy('permission_denied')).toBe(
      'Recued did not install it: you did not allow something it needs.',
    );
    expect(installFailureCopy('version_mismatch')).toBe(
      'Recued did not install it: your server expects a different version.',
    );
    expect(installFailureCopy('validator_rejected')).toBe(
      'Recued did not install it: the Pack did not pass its checks.',
    );
    expect(installFailureCopy('unresolved')).toBe(
      'Recued did not install it: it could not find one or more of the Recipes.',
    );
    expect(installFailureCopy('unexpected')).toBe(
      'Recued did not install it: something went wrong.',
    );
  });

  it('surfaces an unknown code raw (server/webclient version skew)', () => {
    expect(installFailureCopy('quota_exceeded')).toBe(
      'Recued did not install it: quota_exceeded.',
    );
  });

  it('falls back on a missing code', () => {
    expect(installFailureCopy(undefined)).toBe(
      'Recued did not install it, and does not know why.',
    );
  });
});

describe('resolveInstallDialogAccess', () => {
  const model = {
    accessOptions: ['read', 'write'],
    defaultAccess: 'read',
  } as unknown as InstallGrantPickerModel;

  it('returns the pick when the model offers it', () => {
    expect(resolveInstallDialogAccess('write', model)).toBe('write');
  });

  it('clamps an unoffered pick to the model default', () => {
    expect(resolveInstallDialogAccess('all', model)).toBe('read');
  });

  it('returns the model default when nothing was picked', () => {
    expect(resolveInstallDialogAccess(undefined, model)).toBe('read');
  });
});

describe('installFailureCopy — the engine reason survives', () => {
  it('appends the server message and strips its rpc prefix', () => {
    // ⛔ The generic line alone is unactionable. The reason behind invoice-book's
    // rejection named the recipe, the step, the op and the missing pack — and
    // recovering it took a server-side probe a self-hoster cannot run.
    const copy = installFailureCopy(
      'validator_rejected',
      "packs.install: recipe 'delete-billable-item': Tier-P op "
      + "'recued-core.billable-hours.entry.get' (step 'entry') names pack "
      + "'recued-core.billable-hours', which has no resolved catalog binding",
    );
    expect(copy).toContain('the Pack did not pass its checks');
    expect(copy).toContain("recipe 'delete-billable-item'");
    expect(copy).toContain('no resolved catalog binding');
    expect(copy).not.toContain('packs.install:');
  });

  it('is unchanged when the engine sends no message', () => {
    // Negative control — every existing caller and copy string must be intact.
    expect(installFailureCopy('validator_rejected'))
      .toBe('Recued did not install it: the Pack did not pass its checks.');
    expect(installFailureCopy('validator_rejected', '   '))
      .toBe('Recued did not install it: the Pack did not pass its checks.');
    expect(installFailureCopy(undefined)).toBe('Recued did not install it, and does not know why.');
  });
});
