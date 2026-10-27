/** Explicit disposable-realm diagnostics. No names, values, tool arguments,
 * SQL or credentials are retained, and no diagnostic enters a model packet. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatDispatchContext, ChatSourceCitation } from '@recued/contracts';

export const PROJECTION_METRICS_LIMIT = 1000;
export interface ProjectionProbeMetrics {
  version: 1;
  dropped: number;
  probes: Array<{ turn_id?: string; session_id?: string; source_ref: string; scope: 'field' | 'details' | 'context';
    reader: 'field_version' | 'query'; outcome: 'unchanged' | 'refresh_required' | 'refused' | 'failed';
    native_version: boolean; ts: number }>;
}
export const qualificationProjectionMetrics = () => {
  const directory = process.env.RECUED_QUALIFICATION_PROJECTION_METRICS_DIRECTORY;
  if (!directory) return undefined;
  const file = join(directory, `projection-${process.pid}-${randomUUID()}.json`); const temporary = file + '.tmp';
  const metrics: ProjectionProbeMetrics = { version: 1, dropped: 0, probes: [] };
  const flush = () => { try {
    writeFileSync(temporary, JSON.stringify(metrics), { mode: 0o600 }); renameSync(temporary, file);
  } catch { /* Diagnostics cannot change a native read or answer. */ } };
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(metrics), { mode: 0o600 }); }
  catch { return undefined; }
  let queued = false;
  return (ctx: ChatDispatchContext, source: Extract<ChatSourceCitation, { kind: 'asset_projection' }>,
    reader: 'field_version' | 'query', outcome: ProjectionProbeMetrics['probes'][number]['outcome'], native_version: boolean): void => {
    if (metrics.probes.length >= PROJECTION_METRICS_LIMIT) metrics.dropped++;
    else metrics.probes.push({ ...(ctx.turn_id ? { turn_id: ctx.turn_id } : {}), ...(ctx.session_id ? { session_id: ctx.session_id } : {}),
      source_ref: `#source/${source.id}`, scope: source.projection.kind, reader, outcome, native_version, ts: Date.now() });
    if (!queued) { queued = true; queueMicrotask(() => { queued = false; flush(); }); }
  };
};
