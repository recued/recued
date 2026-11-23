import { describe, expect, it } from 'vitest';
import { SETTINGS_FINDER_TARGETS, parseSettingsFinderHash, searchSettingsTargets, settingsFinderHash } from '../settings/settings-finder-targets.js';

describe('Settings finder names and destinations', () => {
  it('finds familiar names and aliases, with the exact title ahead of incidental mentions', () => {
    expect(searchSettingsTargets(SETTINGS_FINDER_TARGETS, 'QUIET HOURS')[0]?.id).toBe('quiet-hours');
    expect(searchSettingsTargets(SETTINGS_FINDER_TARGETS, 'do not disturb')[0]?.id).toBe('quiet-hours');
    expect(searchSettingsTargets(SETTINGS_FINDER_TARGETS, 'time zone')[0]?.id).toBe('timezone');
    expect(searchSettingsTargets(SETTINGS_FINDER_TARGETS, 'default model')[0]?.id).toBe('default-model');
    expect(searchSettingsTargets(SETTINGS_FINDER_TARGETS, 'voice transcription')[0]?.id).toBe('transcription');
  });

  it('sends "tool catalog" to the AI cards that hold it, never to Chat behaviour', () => {
    // The catalog is set per AI on Providers; Chat behaviour no longer shows it.
    expect(searchSettingsTargets(SETTINGS_FINDER_TARGETS, 'tool catalog').map(entry => entry.id))
      .toEqual(['paid-models', 'free-models']);
  });

  it('requires every query term and treats punctuation as text rather than search syntax', () => {
    expect(searchSettingsTargets(SETTINGS_FINDER_TARGETS, 'model default').map(entry => entry.id)).toEqual(['default-model']);
    expect(searchSettingsTargets(SETTINGS_FINDER_TARGETS, 'quiet nonexistent')).toEqual([]);
    expect(searchSettingsTargets(SETTINGS_FINDER_TARGETS, '.*')).toEqual([]);
  });

  it('searches only the supplied available destinations', () => {
    const available = SETTINGS_FINDER_TARGETS.filter(entry => entry.section === 'privacy' || entry.id === 'timezone');
    expect(searchSettingsTargets(available, 'quiet hours').map(entry => entry.id)).toEqual(['timezone']);
    expect(searchSettingsTargets(available, 'clear browser')[0]?.id).toBe('this-browser');
  });

  it('round trips an exact panel address and leaves other settings links to their owners', () => {
    const target = SETTINGS_FINDER_TARGETS.find(entry => entry.id === 'quiet-hours')!;
    expect(parseSettingsFinderHash(settingsFinderHash(target))).toEqual({ section: 'notifications', id: 'quiet-hours' });
    for (const hash of ['#settings/server/timezone', '#settings/ai-models/setup', '#settings/server/find', '#chat/server/find/timezone']) {
      expect(parseSettingsFinderHash(hash)).toBeNull();
    }
  });
});
