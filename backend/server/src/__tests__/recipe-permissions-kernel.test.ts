/** RATCHET — every permission a kernel ingredient declares (`permission` on its
 *  manifest) is one a recipe may require (`RECIPE_PERMISSIONS`, which the recipe
 *  validator reads), or one only the host holds.
 *
 *  ⛔ The validator kept its own list, and when the kernel manifests declared
 *  `notification_send` and `mail_send` it went on warning the recipes that require
 *  them: 244 shipped recipes (2026-10-11). A new kernel permission now fails here
 *  until it is added to contracts' list. */

import { describe, expect, it } from 'vitest';
import { RECIPE_PERMISSIONS } from '@recued/contracts';

import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

/** Held by the host's own dispatch, never asked of an owner for a recipe. */
const HOST_ONLY = new Set(['connection.direct', 'connection.mcp_tool']);

describe('kernel permissions and the recipe validator', () => {
  it('every permission a kernel manifest declares is one a recipe may require, or the host only', () => {
    const declared = [...new Set(KERNEL_MANIFESTS
      .map((manifest) => (manifest as { permission?: unknown }).permission)
      .filter((permission): permission is string => typeof permission === 'string'))];
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((permission) => !RECIPE_PERMISSIONS.has(permission) && !HOST_ONLY.has(permission))).toEqual([]);
  });
});
