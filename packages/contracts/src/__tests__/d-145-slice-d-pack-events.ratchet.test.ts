/** D-145 PA10 follow-on Slice D - pack broadcast event ratchets. */

import { describe, expect, it } from 'vitest';

import {
  ALL_BROADCAST_EVENT_KINDS,
  type ServerEvent,
} from '../events.js';
import { DEFAULT_SUBSCRIPTIONS } from '../pairing.js';

type PackInstalledEvent = Extract<ServerEvent, { kind: 'pack_installed' }>;
type PackUninstalledEvent = Extract<ServerEvent, { kind: 'pack_uninstalled' }>;

const requireCursor = <T extends { cursor: number }>(event: T): number =>
  event.cursor;

describe('D-145 Slice D - pack broadcast event registration', () => {
  it('includes pack_installed in ALL_BROADCAST_EVENT_KINDS', () => {
    expect(ALL_BROADCAST_EVENT_KINDS).toContain('pack_installed');
  });

  it('includes pack_uninstalled in ALL_BROADCAST_EVENT_KINDS', () => {
    expect(ALL_BROADCAST_EVENT_KINDS).toContain('pack_uninstalled');
  });

  it('includes both pack events in DEFAULT_SUBSCRIPTIONS', () => {
    expect(DEFAULT_SUBSCRIPTIONS).toContain('pack_installed');
    expect(DEFAULT_SUBSCRIPTIONS).toContain('pack_uninstalled');
  });
});

describe('D-145 Slice D - pack ServerEvent variants', () => {
  it('pack_installed satisfies the ServerEvent discriminant without casts', () => {
    const installed: PackInstalledEvent = {
      kind: 'pack_installed',
      pack_slug: 'personal-organizer-foundation',
      pack_name: 'Personal Organizer Foundation',
      pack_version: 1,
      installed_recipe_count: 2,
      cursor: 11,
    };
    const event: ServerEvent = installed;

    expect(event.kind).toBe('pack_installed');
    if (event.kind === 'pack_installed') {
      expect(event.pack_slug).toBe('personal-organizer-foundation');
      expect(event.pack_name).toBe('Personal Organizer Foundation');
      expect(event.pack_version).toBe(1);
      expect(event.installed_recipe_count).toBe(2);
      expect(event.cursor).toBe(11);
    }
  });

  it('pack_uninstalled satisfies the ServerEvent discriminant without casts', () => {
    const uninstalled: PackUninstalledEvent = {
      kind: 'pack_uninstalled',
      pack_slug: 'personal-organizer-foundation',
      pack_name: 'Personal Organizer Foundation',
      pack_version: 1,
      removed_recipe_count: 2,
      cursor: 12,
    };
    const event: ServerEvent = uninstalled;

    expect(event.kind).toBe('pack_uninstalled');
    if (event.kind === 'pack_uninstalled') {
      expect(event.pack_slug).toBe('personal-organizer-foundation');
      expect(event.pack_name).toBe('Personal Organizer Foundation');
      expect(event.pack_version).toBe(1);
      expect(event.removed_recipe_count).toBe(2);
      expect(event.cursor).toBe(12);
    }
  });

  it('requires and carries cursor on both pack event variants', () => {
    const installed: PackInstalledEvent = {
      kind: 'pack_installed',
      pack_slug: 'pack-a',
      pack_name: 'Pack A',
      pack_version: 2,
      installed_recipe_count: 0,
      cursor: 21,
    };
    const uninstalled: PackUninstalledEvent = {
      kind: 'pack_uninstalled',
      pack_slug: 'pack-a',
      pack_name: 'Pack A',
      pack_version: 2,
      removed_recipe_count: 0,
      cursor: 22,
    };

    expect('cursor' in installed).toBe(true);
    expect('cursor' in uninstalled).toBe(true);
    expect(requireCursor(installed)).toBe(21);
    expect(requireCursor(uninstalled)).toBe(22);
  });
});
