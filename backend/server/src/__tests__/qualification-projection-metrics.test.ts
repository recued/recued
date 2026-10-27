import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sourceCitation } from '../chat-source-citations.js';
import { createProjectionVersionProbe } from '../chat-projection-refresh.js';
import { PROJECTION_METRICS_LIMIT, qualificationProjectionMetrics, type ProjectionProbeMetrics } from '../qualification-projection-metrics.js';

const folders: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const folder = () => { const path = mkdtempSync(join(tmpdir(), 'projection-metrics-test-')); folders.push(path); return path; };
const source = sourceCitation({ kind: 'asset_projection', asset_id: 'private-asset-address@example.test',
  projection: { kind: 'field', field: 'attributes.private_note' } }, 'Private customer contents', 'a'.repeat(64), 100);
const ctx = { channel: 'internal_function_call' as const, session_id: 'session-fixture', turn_id: 'turn-fixture' };

describe('opt-in projection qualification diagnostics', () => {
  it('stays disabled by default and cannot stop a valid read when the output location is unavailable', async () => {
    vi.stubEnv('RECUED_QUALIFICATION_PROJECTION_METRICS_DIRECTORY', undefined);
    expect(qualificationProjectionMetrics()).toBeUndefined();
    const occupied = join(folder(), 'occupied'); writeFileSync(occupied, 'A file is not a directory');
    vi.stubEnv('RECUED_QUALIFICATION_PROJECTION_METRICS_DIRECTORY', occupied);
    const query = vi.fn(async () => ({ ok: true as const, result: {}, source_citations: [source] }));
    const probe = createProjectionVersionProbe({ query, admit: () => true, now: () => 100 });
    expect(await probe(source, ctx)).toBe(true); expect(query).toHaveBeenCalledTimes(1);
  });

  it('records bounded native decisions while excluding asset names, values, field names and locators', async () => {
    const directory = folder(); vi.stubEnv('RECUED_QUALIFICATION_PROJECTION_METRICS_DIRECTORY', directory);
    const record = qualificationProjectionMetrics()!;
    for (let i = 0; i < PROJECTION_METRICS_LIMIT + 1; i++) record(ctx, source, 'field_version', 'unchanged', true);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    const files = readdirSync(directory); expect(files).toHaveLength(1);
    const text = readFileSync(join(directory, files[0]!), 'utf8'); const result = JSON.parse(text) as ProjectionProbeMetrics;
    expect(result.probes).toHaveLength(PROJECTION_METRICS_LIMIT); expect(result.dropped).toBe(1);
    expect(result.probes[0]).toMatchObject({ session_id: ctx.session_id, turn_id: ctx.turn_id, source_ref: `#source/${source.id}`, scope: 'field',
      reader: 'field_version', outcome: 'unchanged', native_version: true });
    for (const secret of [source.asset_id, source.label, source.projection.field]) expect(text).not.toContain(secret);
  });
});
