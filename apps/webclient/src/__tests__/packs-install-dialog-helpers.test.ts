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
      'Install rejected: a required permission was not granted.',
    );
    expect(installFailureCopy('version_mismatch')).toBe(
      'Install rejected: the server runs a different pack manifest version.',
    );
    expect(installFailureCopy('validator_rejected')).toBe(
      'Install rejected: the manifest failed substrate validation.',
    );
    expect(installFailureCopy('unresolved')).toBe(
      'Install rejected: one or more recipes in the pack could not be resolved.',
    );
    expect(installFailureCopy('unexpected')).toBe(
      'Install rejected: an unexpected substrate error occurred.',
    );
  });

  it('surfaces an unknown code raw (server/webclient version skew)', () => {
    expect(installFailureCopy('quota_exceeded')).toBe(
      'Install rejected: quota_exceeded.',
    );
  });

  it('falls back on a missing code', () => {
    expect(installFailureCopy(undefined)).toBe(
      'Install rejected: unknown failure.',
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
