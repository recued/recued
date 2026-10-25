import { describe, expect, it } from 'vitest';
import type { AssetRule } from '@recued/contracts';
import { ruleScheduleSummary } from '../yours/bootstrap-yours-route.js';
import { reminderTimingWords } from '../yours/proposal-preview.js';

const rule = (patch: Partial<AssetRule>): AssetRule => ({ id: 'service', title: 'Service', enabled: true, muted: false, pinned: false,
  consequence: 'routine', expiry_policy: 'strict_expire', when: { kind: 'expiry', field: 'due_on' },
  reaction: { notify: true, occurrence: 'action', emit: false },
  schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true, after: { amount: 2, unit: 'weeks' } }, ...patch });

describe('D-325 Yours rule schedule summary (P47)', () => {
  it('does not promise repetition when an unloaded rule may lapse on its due day', () => {
    const schedule = rule({}).schedule;
    expect(reminderTimingWords(schedule)).toContain('repeat requested every 2 weeks; review the saved expiry policy');
    expect(reminderTimingWords(schedule, 'strict_expire')).not.toContain('then every');
    expect(reminderTimingWords(schedule, 'escalate_overdue')).toContain('then every 2 weeks');
  });
  it('describes repeats only for a clock that stays overdue', () => {
    expect(ruleScheduleSummary(rule({}))).toBe('remind 1 months, on the day; it lapses on the due day, so it does not repeat');
    expect(ruleScheduleSummary(rule({ expiry_policy: 'escalate_overdue' }))).toBe('remind 1 months, on the day; then every 2 weeks');
    expect(ruleScheduleSummary(rule({ schedule: { before: [], on_day: false } }))).toBe('remind no earlier points');
  });
});
