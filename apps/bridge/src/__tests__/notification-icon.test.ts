/** The Bridge's default notification icon is one Chrome can show (`notifications/icon.ts`). */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_NOTIFICATION_ICON_PATH } from '../notifications/icon.js';

const PUBLIC = resolve(import.meta.dirname, '../../public');

describe('the Bridge\'s default notification icon', () => {
  it('ships with the extension, as a PNG: Chrome refuses an SVG for a notification', () => {
    const file = join(PUBLIC, DEFAULT_NOTIFICATION_ICON_PATH);
    expect(existsSync(file)).toBe(true);
    // The PNG signature, not the name: a renamed SVG is still refused.
    expect([...readFileSync(file).subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('is the one the service worker passes, not a copy of the path of its own', () => {
    const entry = readFileSync(resolve(import.meta.dirname, '../boot/service-worker-entry.ts'), 'utf8');
    expect(entry).toContain("import { DEFAULT_NOTIFICATION_ICON_PATH } from '../notifications/icon.js';");
    expect(entry).not.toMatch(/icons\/logo\.svg/);
  });
});
