/** D-182 — cli executor failure classification contract. */

import { describe, expect, it } from 'vitest';

import {
  CLI_FAILURE_REASONS,
  cliFailureErrorCode,
  cliSpawnErrorReason,
  isCliFailureDetail,
} from '../cli-failure.js';

describe('cli-failure classification contract', () => {
  it('cliSpawnErrorReason: only ENOENT → not_found, every other code → spawn_error', () => {
    expect(cliSpawnErrorReason('ENOENT')).toBe('not_found');
    expect(cliSpawnErrorReason('EACCES')).toBe('spawn_error');
    expect(cliSpawnErrorReason('EPERM')).toBe('spawn_error');
    expect(cliSpawnErrorReason(undefined)).toBe('spawn_error');
    expect(cliSpawnErrorReason(null)).toBe('spawn_error');
  });

  it('cliFailureErrorCode: not_found → CLI_TOOL_NOT_FOUND, every other reason → CLI_TOOL_FAILED', () => {
    expect(cliFailureErrorCode('not_found')).toBe('CLI_TOOL_NOT_FOUND');
    for (const reason of CLI_FAILURE_REASONS) {
      if (reason === 'not_found') continue;
      expect(cliFailureErrorCode(reason)).toBe('CLI_TOOL_FAILED');
    }
  });

  it('CLI_FAILURE_REASONS is the closed canonical set', () => {
    expect([...CLI_FAILURE_REASONS]).toEqual([
      'not_found',
      'spawn_error',
      'nonzero_exit',
      'timeout',
      'bad_output',
    ]);
  });

  it('isCliFailureDetail accepts a well-formed carrier, rejects everything malformed', () => {
    expect(isCliFailureDetail({ reason: 'not_found' })).toBe(true);
    expect(isCliFailureDetail({ reason: 'bad_output', exit_code: 0, stderr: 'x' })).toBe(true);
    // A reason outside the closed set must be rejected (a hand-injected carrier).
    expect(isCliFailureDetail({ reason: 'bogus' })).toBe(false);
    expect(isCliFailureDetail({})).toBe(false);
    expect(isCliFailureDetail(null)).toBe(false);
    expect(isCliFailureDetail(undefined)).toBe(false);
    expect(isCliFailureDetail('not_found')).toBe(false);
  });
});
