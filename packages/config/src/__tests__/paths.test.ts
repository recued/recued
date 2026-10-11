import { describe, expect, it } from 'vitest';
import {
  defaultConfigPath,
  detectOs,
  expandHome,
} from '../paths.js';

describe('paths', () => {
  describe('detectOs', () => {
    it('maps darwin / win32 / linux explicitly', () => {
      expect(detectOs('darwin')).toBe('darwin');
      expect(detectOs('win32')).toBe('windows');
      expect(detectOs('linux')).toBe('linux');
    });

    it('falls back to linux for anything else', () => {
      expect(detectOs('freebsd')).toBe('linux');
      expect(detectOs('openbsd')).toBe('linux');
    });
  });

  describe('defaultConfigPath', () => {
    it('macOS uses Application Support', () => {
      const p = defaultConfigPath({ os: 'darwin', home: '/Users/alice' });
      expect(p).toBe('/Users/alice/Library/Application Support/Recued/config.toml');
    });

    it('Windows honours %APPDATA%', () => {
      const p = defaultConfigPath({
        os: 'windows',
        home: 'C:\\Users\\alice',
        appData: 'C:\\Users\\alice\\AppData\\Roaming',
      });
      // join uses the platform sep; on *nix tests we get forward slashes.
      expect(p.endsWith('Recued/config.toml') || p.endsWith('Recued\\config.toml')).toBe(true);
    });

    it('Linux honours XDG_CONFIG_HOME', () => {
      const p = defaultConfigPath({
        os: 'linux',
        home: '/home/alice',
        xdgConfigHome: '/custom/xdg',
      });
      expect(p).toBe('/custom/xdg/recued/config.toml');
    });

    it('Linux falls back to ~/.config without XDG', () => {
      const p = defaultConfigPath({
        os: 'linux',
        home: '/home/alice',
        xdgConfigHome: undefined,
      });
      expect(p).toBe('/home/alice/.config/recued/config.toml');
    });
  });

  describe('expandHome', () => {
    it('rewrites leading ~/', () => {
      expect(expandHome('~/data', '/home/alice')).toBe('/home/alice/data');
    });

    it('rewrites bare ~', () => {
      expect(expandHome('~', '/home/alice')).toBe('/home/alice');
    });

    it('leaves absolute paths untouched', () => {
      expect(expandHome('/etc/recued', '/home/alice')).toBe('/etc/recued');
    });

    it('does not touch tilde in the middle of a path', () => {
      expect(expandHome('/foo/~/bar', '/home/alice')).toBe('/foo/~/bar');
    });
  });

});
