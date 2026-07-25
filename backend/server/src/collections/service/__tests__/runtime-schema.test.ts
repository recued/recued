/** D-118 Phase 2 — runtime-schema entries for the service surface.
 *
 *  Four keys ride on the existing `RUNTIME_SCHEMA` array. These
 *  assertions guard the wire — renaming or dropping a key here
 *  silently breaks the gate on a re-pair, so the test is the
 *  cheapest way to catch drift.
 */

import { describe, expect, it } from 'vitest';

import { RUNTIME_SCHEMA_MAP, runtimeDefaults } from '@recued/config';
import {
  SERVICE_MIN_DISK_FREE_BYTES_DEFAULT,
  SERVICE_QUOTA_BYTES_DEFAULT,
} from '@recued/contracts';

describe('runtime schema — collection.service.* keys', () => {
  it('default quota_bytes is registered + matches the contract constant', () => {
    const entry = RUNTIME_SCHEMA_MAP['collection.service.default.quota_bytes'];
    expect(entry).toBeDefined();
    expect(entry.type).toBe('number');
    expect(entry.default).toBe(SERVICE_QUOTA_BYTES_DEFAULT);
  });

  it('min_disk_free_bytes is registered + matches the contract constant', () => {
    const entry = RUNTIME_SCHEMA_MAP['collection.service.min_disk_free_bytes'];
    expect(entry).toBeDefined();
    expect(entry.type).toBe('number');
    expect(entry.default).toBe(SERVICE_MIN_DISK_FREE_BYTES_DEFAULT);
  });

  it('invoke_slack_bytes defaults to 100 MiB', () => {
    const entry = RUNTIME_SCHEMA_MAP['collection.service.invoke_slack_bytes'];
    expect(entry).toBeDefined();
    expect(entry.default).toBe(100 * 1024 * 1024);
  });

  it('du_sample_interval_s defaults to 30 seconds', () => {
    const entry = RUNTIME_SCHEMA_MAP['collection.service.du_sample_interval_s'];
    expect(entry).toBeDefined();
    expect(entry.default).toBe(30);
    expect(entry.min).toBe(5);
  });

  it('every key is in `runtimeDefaults()` so the loader picks them up', () => {
    const defaults = runtimeDefaults();
    const keys = [
      'collection.service.default.quota_bytes',
      'collection.service.min_disk_free_bytes',
      'collection.service.invoke_slack_bytes',
      'collection.service.du_sample_interval_s',
    ];
    for (const k of keys) {
      expect(defaults[k]).toBeDefined();
    }
  });

  it('quota knobs sit in the Collections section so they group with mail/file/calendar', () => {
    const entry = RUNTIME_SCHEMA_MAP['collection.service.default.quota_bytes'];
    expect(entry.section).toBe('Collections');
  });
});
