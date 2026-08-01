/** D-178 / D-158 — the message an owner actually reads.
 *
 *  `describeAvailable` is the whole user-facing surface of the scheduled check.
 *  Every fact it drops is a fact the owner does not have, and there is no other
 *  place they would learn it from — the notification is pushed precisely because
 *  nobody is looking at a screen. So each flag gets a test, and each test names
 *  what the owner loses if the clause disappears.
 */

import { describe, expect, it } from 'vitest';
import type { ReleaseCheckResponse } from '@recued/contracts';
import { describeAvailable } from '../update/auto-apply-task.js';

const res = (over: Partial<NonNullable<ReleaseCheckResponse['available']>> = {}): ReleaseCheckResponse =>
  ({
    status: 'update-available',
    current_version: '1.3.0',
    channel: 'stable',
    sequence: 8,
    available: {
      version: '1.4.2',
      migration: false,
      is_major: false,
      below_min_supported: false,
      in_rollout_cohort: true,
      auto_apply_eligible: true,
      notes_url: 'https://releases.example/notes/1.4.2',
      ...over,
    },
  }) as ReleaseCheckResponse;

describe('describeAvailable', () => {
  it('names both versions, so "available" is not a bare assertion', () => {
    const m = describeAvailable(res(), '1.4.2');
    expect(m.title).toBe('Update available');
    expect(m.text).toContain('1.4.2');
    expect(m.text).toContain('1.3.0');
    expect(m.link_url).toBe('https://releases.example/notes/1.4.2');
  });

  it('escalates the title when the running version is below min_supported', () => {
    // Lose this and an unsupported server reads identically to a routine bump.
    const m = describeAvailable(res({ below_min_supported: true }), '1.4.2');
    expect(m.title).toBe('Update urgently available');
    expect(m.text).toContain('urgent');
  });

  it('says a major is never applied automatically', () => {
    // Lose this and an owner on auto-apply waits for an update that will not
    // arrive on its own (I-4).
    expect(describeAvailable(res({ is_major: true }), '2.0.0').text).toContain('never applied automatically');
  });

  it('says a migrating release migrates, and that a snapshot makes it reversible', () => {
    // Both halves matter: the risk, and the fact that it is recoverable.
    const t = describeAvailable(res({ migration: true }), '1.4.2').text;
    expect(t).toContain('migrates the database');
    expect(t).toContain('rolled back');
  });

  it('discloses that the staged rollout has not reached this server', () => {
    // ⛔ The rollout decides what AUTO-applies, not what the owner may know.
    // Suppressing this would be the substrate exercising the human's judgment.
    const t = describeAvailable(res({ in_rollout_cohort: false }), '1.4.2').text;
    expect(t).toContain('has not reached this server');
    expect(t).toContain('apply it yourself');
  });

  it('omits the link rather than inventing one when the release has no notes', () => {
    const m = describeAvailable(res({ notes_url: undefined }), '1.4.2');
    expect(m.link_url).toBeUndefined();
  });

  it('carries every flag at once without dropping any', () => {
    // The combination is the case a per-flag test cannot catch: an early return
    // or an else-if chain passes each single-flag test and loses the rest.
    const t = describeAvailable(
      res({ below_min_supported: true, is_major: true, migration: true, in_rollout_cohort: false }),
      '2.0.0',
    ).text;
    expect(t).toContain('urgent');
    expect(t).toContain('never applied automatically');
    expect(t).toContain('migrates the database');
    expect(t).toContain('has not reached this server');
  });
});
