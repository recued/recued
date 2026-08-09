import {
  ONEDRIVE_OAUTH_SCOPES,
  SHAREPOINT_OAUTH_SCOPES,
} from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { VENDOR_CONNECTION_SCHEMAS } from '../connection-schemas/index.js';

/** ⛔⛔⛔ THE SETUP COPY AND THE SCOPE SEED MUST NAME THE SAME THINGS, and until now
 *  nothing checked it. The OneDrive / SharePoint schemas tell the owner which delegated
 *  Graph permissions to add to their own Entra app. If that list omits a scope the
 *  enrollment then REQUESTS, the owner builds an app that cannot satisfy the request and
 *  discovers it at the consent screen — after registering an app, which is exactly where
 *  people abandon a setup.
 *
 *  🔑 IT WENT STALE THE MOMENT THE SEEDS WIDENED. The 2026-08-07 owner decision added
 *  `Files.ReadWrite` / `Sites.ReadWrite.All` to the seeds; the copy still said
 *  "`Files.Read`, `offline_access`, and `User.Read`". Both halves shipped from the same
 *  change, and only a human reading two files noticed — the same shape as the callback-URL
 *  wording that had to be fixed twice because a correct mechanism was described wrongly.
 *
 *  ⚠ ASSERTS THE COPY ⊇ THE SEED, not equality. A schema may legitimately mention extra
 *  permissions (SharePoint's `site_url` field discusses site resolution), and requiring
 *  an exact match would make every helpful sentence a test failure. What must never
 *  happen is a REQUESTED scope going unmentioned. */
const schemaText = (vendor: string): string => {
  const schema = (VENDOR_CONNECTION_SCHEMAS as Record<string, unknown>)[vendor];
  expect(schema, `${vendor} has no connection schema`).toBeDefined();
  return JSON.stringify(schema);
};

describe('Microsoft Graph setup copy names every scope enrollment will request', () => {
  it.each([
    ['onedrive', ONEDRIVE_OAUTH_SCOPES],
    ['sharepoint', SHAREPOINT_OAUTH_SCOPES],
  ])('%s', (vendor, scopes) => {
    const copy = schemaText(vendor as string);
    /** The control: a schema that stringified to nothing useful would pass every
     *  `toContain` below by accident. */
    expect(copy.length, `${vendor} schema is suspiciously small`).toBeGreaterThan(200);
    expect([...scopes].length, `${vendor} seeds no scopes`).toBeGreaterThan(0);

    for (const scope of scopes) {
      expect(
        copy,
        `${vendor} enrollment requests '${scope}' but the setup copy never names it — `
          + 'the owner would build an Entra app that cannot satisfy the request',
      ).toContain(scope);
    }
  });

  it('⚠ the two vendors do NOT share a scope family — the split is structural', () => {
    /** A guard against "simplifying" the two schemas into one shared block. `Files.*` is
     *  scoped to the signed-in user's own OneDrive and 403s on a SharePoint site drive,
     *  so the split is about WHICH RESOURCE is reachable, not a read-vs-write tier
     *  choice — it survived the widening for that reason and must survive the next one. */
    expect([...SHAREPOINT_OAUTH_SCOPES].some((s) => s.startsWith('Files.'))).toBe(false);
    expect([...ONEDRIVE_OAUTH_SCOPES].some((s) => s.startsWith('Sites.'))).toBe(false);
  });
});
