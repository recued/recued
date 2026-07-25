import { describe, expect, it } from 'vitest';
import {
  defaultConfigPath,
  defaultDataPath,
  detectOs,
  expandDataPath,
  expandHome,
  resolveBootstrapPath,
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

  describe('defaultDataPath', () => {
    it('differs from config path on Linux (XDG_DATA_HOME)', () => {
      const p = defaultDataPath({
        os: 'linux',
        home: '/home/alice',
        xdgDataHome: '/custom/data',
      });
      expect(p).toBe('/custom/data/recued');
    });

    it('falls back to ~/.local/share on Linux', () => {
      const p = defaultDataPath({
        os: 'linux',
        home: '/home/alice',
      });
      expect(p).toBe('/home/alice/.local/share/recued');
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

  describe('expandDataPath', () => {
    it('substitutes the {data_path} token', () => {
      expect(expandDataPath('{data_path}/logs', '/data')).toBe('/data/logs');
    });

    it('substitutes multiple occurrences', () => {
      expect(expandDataPath('{data_path}/x/{data_path}', '/d')).toBe('/d/x//d');
    });

    it('no-ops when absent', () => {
      expect(expandDataPath('/abs/logs', '/d')).toBe('/abs/logs');
    });
  });

  describe('resolveBootstrapPath', () => {
    it('expands ~ + {data_path} and resolves absolute', () => {
      const out = resolveBootstrapPath('{data_path}/logs', '~/data', '/home/alice');
      expect(out).toBe('/home/alice/data/logs');
    });
  });
});
