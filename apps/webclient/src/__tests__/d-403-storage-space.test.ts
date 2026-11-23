/** D-403 (D-403) — Server ▸ Storage: what takes space, and the owner's purge.
 *
 *  The panel's DOM is driven in real Chrome (the verify harness and `scripts/drives/d-403-storage-live.mjs`);
 *  here, the cutoff a choice means, and the composition seam: a panel that renders when handed callers
 *  proves nothing about whether anything hands it them. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STORAGE_PURGE_MIN_AGE_MS } from '@recued/contracts';
import { storagePurgeCutoff } from '../settings/storage-space-panel-mount.js';
import { SERVER_SUBTAB_LABELS } from '../settings/bootstrap-settings-route.js';

describe('D-403 — the cutoff a choice means', () => {
  // Noon on Nov 17, 2026, in the test machine's own zone: the cutoff is local midnight, months back.
  const now = new Date(2026, 10, 17, 12, 0, 0).getTime();

  it('is midnight that many calendar months back', () => {
    expect(storagePurgeCutoff('3', '', now)).toBe(new Date(2026, 7, 17).getTime());
    expect(storagePurgeCutoff('6', '', now)).toBe(new Date(2026, 4, 17).getTime());
    expect(storagePurgeCutoff('12', '', now)).toBe(new Date(2025, 10, 17).getTime());
  });

  it('is the chosen day\'s midnight, and nothing for a date that is not one', () => {
    expect(storagePurgeCutoff('date', '2026-03-02', now)).toBe(new Date(2026, 2, 2).getTime());
    expect(storagePurgeCutoff('date', '', now)).toBeUndefined();
    expect(storagePurgeCutoff('date', 'March 2', now)).toBeUndefined();
  });

  it('never reaches into the last day, which the server keeps', () => {
    for (const choice of ['3', '6', '12'] as const) {
      expect(storagePurgeCutoff(choice, '', now)! <= now - STORAGE_PURGE_MIN_AGE_MS, choice).toBe(true);
    }
  });
});

describe('⛔ D-403 — the composition seam: the route HANDS the panel its callers', () => {
  const bootstrap = readFileSync(new URL('../webclient-bootstrap.ts', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../settings/bootstrap-settings-route.ts', import.meta.url), 'utf8');

  it('builds each caller from its real rpc, passes it to the route, and the route forwards it into the mount', () => {
    for (const [caller, method] of [
      ['storageKindsCaller', 'storage.kinds.read'], ['storagePurgePreviewCaller', 'storage.purge.preview'],
      ['storagePurgeRunCaller', 'storage.purge.run'], ['storageRecordsExportCaller', 'records.export'],
      ['storageRunsExportCaller', 'audit.export.page'],
    ] as const) {
      expect(bootstrap, caller).toMatch(new RegExp(`const ${caller} =[\\s\\S]{0,240}'${method.replaceAll('.', '\\.')}'`, 'u'));
      expect(bootstrap, caller).toMatch(new RegExp(`\\n\\s+(?:${caller},|${caller}: switchWorkTracker\\.track\\(${caller}\\),)`, 'u'));
    }
    expect(route).toMatch(/readKinds: opts\.storageKindsCaller!/u);
    expect(route).toMatch(/preview: opts\.storagePurgePreviewCaller!/u);
    expect(route).toMatch(/run: opts\.storagePurgeRunCaller!/u);
    expect(route).toMatch(/exportRecords: opts\.storageRecordsExportCaller/u);
    expect(route).toMatch(/exportRuns: opts\.storageRunsExportCaller/u);
    // The delete is tracked, so a route switch waits for it rather than dropping its answer.
    expect(bootstrap).toMatch(/storagePurgeRunCaller: switchWorkTracker\.track\(storagePurgeRunCaller\)/u);
  });

  it('is a Server tab named Storage, after Maintenance', () => {
    expect(SERVER_SUBTAB_LABELS.storage).toBe('Storage');
    expect(Object.keys(SERVER_SUBTAB_LABELS).indexOf('storage')).toBe(Object.keys(SERVER_SUBTAB_LABELS).indexOf('maintenance') + 1);
  });
});
