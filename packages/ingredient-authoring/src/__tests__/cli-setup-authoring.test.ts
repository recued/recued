import { describe, expect, it } from 'vitest';
import { CLI_INSTALL_MANAGERS, CLI_INSTALL_SYSTEMS, CLI_VERSION_OUTSIDE } from '@recued/contracts';
import { cliVersionProblems, cliInstallProblems } from '@recued/ingredients/cli-tool-policy';
import { cliSetupFields, cliSetupKeyAllowed, CLI_SETUP_KEYS } from '../cli-setup-authoring.js';

describe('shared CLI tool setup metadata and problem locations', () => {
  it('shares the closed CLI cell vocabulary and explicit policy/manager/system choices', () => {
    expect(CLI_SETUP_KEYS).toEqual(['tool', 'probe', 'config_dir', 'profile', 'package_ref', 'entry_point', 'version', 'install']);
    expect(cliSetupKeyAllowed('version')).toBe(true); expect(cliSetupKeyAllowed('toString')).toBe(false); expect(cliSetupKeyAllowed('__proto__')).toBe(false);
    expect(cliSetupFields('version').find(row => row.key === 'outside')!.values).toEqual(CLI_VERSION_OUTSIDE);
    expect(cliSetupFields('install', 'package').find(row => row.key === 'manager')!.values).toEqual(CLI_INSTALL_MANAGERS);
    expect(cliSetupFields('install', 'package').find(row => row.key === 'systems')!.values).toEqual(CLI_INSTALL_SYSTEMS);
  });
  it('keeps installation variants exclusive and labels requiredness only after a variant is authored', () => {
    expect(cliSetupFields('install', 'docs').map(row => row.key)).toEqual(['docs']);
    expect(cliSetupFields('install', 'package').map(row => row.key)).toEqual(['manager', 'package', 'systems']);
    expect(cliSetupFields('install').some(row => row.required)).toBe(false);
    expect(cliSetupFields('install', 'package').filter(row => row.required).map(row => row.key)).toEqual(['manager', 'package']);
    expect(cliSetupFields('tested').find(row => row.key === 'before')!.description).toContain('Exclusive');
  });
  it('locates unknown literal keys without changing their rejection messages or treating dots as nested paths', () => {
    const version = { tested: { from: '1.0', 'before.bad': '2' }, outside: 'refuse', 'tested.from': '9' }, before = JSON.stringify(version);
    const problems = cliVersionProblems(version); expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({ path: '["tested.from"]', message: 'version.tested.from is not a version setting (tested, outside)', reference_span: { target: 'key', offset: 0, length: 11 } });
    expect(problems[1]).toMatchObject({ path: 'tested["before.bad"]', reference_span: { target: 'key', offset: 0, length: 10 } });
    const hints = cliInstallProblems([{ manager: 'brew', package: 'ffmpeg', 'docs.bad': 'https://example.com' }]);
    expect(hints).toHaveLength(1); expect(hints[0]).toMatchObject({ path: '[0]["docs.bad"]', reference_span: { target: 'key', offset: 0, length: 8 } });
    expect(JSON.stringify(version)).toBe(before);
  });
  it('keeps semantic errors on values and preserves malformed/version/install admission', () => {
    const invalid = cliVersionProblems({ tested: { from: '2', before: '1' }, outside: 'refuse' });
    expect(invalid).toEqual([{ path: 'tested.before', message: 'version.tested.before (1) must be above from (2)' }]);
    expect(cliVersionProblems({ tested: { from: '1' }, outside: 'warn' })).toEqual([]);
    expect(cliInstallProblems([{ docs: 'http://example.com' }])).toEqual([{ path: '[0].docs', message: 'docs must be an https link, with no user name or password' }]);
    expect(cliInstallProblems([{ manager: 'brew', package: 'ffmpeg', systems: ['macos', 'macos'] }])).toEqual([{ path: '[0].systems', message: 'systems must list one or more of macos, linux, windows, each once' }]);
  });
});
