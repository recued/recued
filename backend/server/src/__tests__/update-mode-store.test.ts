import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  channelDefaultMode,
  createUpdateModeStore,
  resolveUpdateMode,
} from '../update/update-mode-store.js';

describe('channelDefaultMode', () => {
  it('auto on self-updating channels, notify on delegated', () => {
    expect(channelDefaultMode('binary')).toBe('auto');
    expect(channelDefaultMode('docker-thin')).toBe('auto');
    expect(channelDefaultMode('docker-baked')).toBe('notify');
    expect(channelDefaultMode('source')).toBe('notify');
  });
});

describe('createUpdateModeStore', () => {
  it('persists + reads back a user override; null when unset', () => {
    const db = new Database(':memory:');
    const s = createUpdateModeStore(db);
    expect(s.readUserMode()).toBeNull();
    s.setUserMode('off');
    expect(createUpdateModeStore(db).readUserMode()).toBe('off');
  });
});

describe('resolveUpdateMode', () => {
  it('env wins and locks', () => {
    const r = resolveUpdateMode({ channel: 'binary', userMode: 'off', envMode: 'notify' });
    expect(r).toMatchObject({ mode: 'notify', source: 'env', env_locked: true, channel_default: 'auto' });
  });
  it('user override beats channel default', () => {
    const r = resolveUpdateMode({ channel: 'binary', userMode: 'off' });
    expect(r).toMatchObject({ mode: 'off', source: 'user', env_locked: false });
  });
  it('falls back to channel default', () => {
    const r = resolveUpdateMode({ channel: 'docker-baked', userMode: null });
    expect(r).toMatchObject({ mode: 'notify', source: 'default', env_locked: false, channel_default: 'notify' });
  });
  it('ignores an invalid env value', () => {
    const r = resolveUpdateMode({ channel: 'binary', userMode: null, envMode: 'garbage' });
    expect(r.source).toBe('default');
    expect(r.env_locked).toBe(false);
  });
});
