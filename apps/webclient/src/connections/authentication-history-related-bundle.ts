import { AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES } from '@recued/contracts';
import type { PreparedAuthenticationHistoryDownload } from './authentication-history-export.js';

type Entry = PreparedAuthenticationHistoryDownload['report']['entries'][number];
export type AuthenticationHistorySavedReference = { readonly type: Entry['type']; readonly id: string };
type Reference = AuthenticationHistorySavedReference;
type MissingReference = { readonly from: Reference; readonly to: Reference; readonly reason: 'outside_snapshot' | 'type_mismatch' };
export interface AuthenticationHistoryRelatedBundle {
  readonly filename: string;
  readonly report: {
    readonly format: 'recued.connection-history.related'; readonly version: 1;
    readonly privacy_mode: 'aliases' | 'full'; readonly alias_scope?: 'source_snapshot';
    readonly evidence: 'retained_local_observations'; readonly current_authentication: 'not_checked';
    readonly coverage: 'source_snapshot_only'; readonly unrecorded_or_excluded_links: 'not_known';
    readonly link_rule: 'saved_record_references_both_directions';
    readonly root: { readonly type: 'incident'; readonly id: string; readonly source_position: number };
    readonly source_snapshot: Pick<PreparedAuthenticationHistoryDownload['report'], 'format' | 'version' | 'exported_at' | 'scope' | 'filters' | 'retention_days' | 'finished_record_limit' | 'entry_count'>;
    readonly entry_count: number; readonly counts: Readonly<Record<Entry['type'], number>>;
    readonly entries: readonly Entry[]; readonly incomplete_record_count: number;
    readonly missing_reference_count: number; readonly missing_references: readonly MissingReference[];
  };
}

export const authenticationHistorySavedReferences = (entry: Entry): Reference[] => {
  const r = entry.record;
  if (entry.type === 'repair' && 'incidents' in r) return r.incidents.map(i => ({ type: 'incident', id: i.id }));
  if (entry.type === 'verification' && 'selection' in r && r.selection.kind !== 'group') return [{ type: r.selection.kind, id: r.selection.id }];
  return [];
};
const reference = (entry: Entry): Reference => Object.freeze({ type: entry.type, id: entry.record.id });
const incomplete = (entry: Entry): boolean => Object.entries(entry.record).some(([key, value]) => value === true
  && ['events_truncated', 'details_truncated', 'targets_truncated', 'incidents_truncated', 'incomplete', 'references_incomplete'].includes(key));

/** Index only explicit, typed saved-record links. Group/app/account similarity
 * never establishes a link. Build lazily once for this immutable preview. */
export const createAuthenticationHistoryRelatedBundles = (snapshot: PreparedAuthenticationHistoryDownload): ((incidentIndex: number) => AuthenticationHistoryRelatedBundle) => {
  const source = snapshot.report; const entries = source.entries;
  let graph: { neighbors: Set<number>[]; missing: MissingReference[][] } | undefined;
  return incidentIndex => {
    const root = entries[incidentIndex];
    if (!Number.isInteger(incidentIndex) || incidentIndex < 0 || root?.type !== 'incident') throw new Error('Choose an incident from this preview.');
    if (!graph) {
      const byId = new Map(entries.map((entry, index) => [entry.record.id, index]));
      const neighbors = entries.map(() => new Set<number>()); const missing: MissingReference[][] = entries.map(() => []);
      entries.forEach((entry, index) => {
        const seen = new Set<string>();
        for (const to of authenticationHistorySavedReferences(entry)) {
          const key = JSON.stringify([to.type, to.id]); if (seen.has(key)) continue; seen.add(key);
          const target = byId.get(to.id);
          if (target === undefined || entries[target]!.type !== to.type) {
            missing[index]!.push(Object.freeze({ from: reference(entry), to: Object.freeze(to), reason: target === undefined ? 'outside_snapshot' : 'type_mismatch' }));
          } else { neighbors[index]!.add(target); neighbors[target]!.add(index); }
        }
      });
      graph = { neighbors, missing };
    }
    const selected = new Set([incidentIndex]); const queue = [incidentIndex];
    for (let cursor = 0; cursor < queue.length; cursor++) for (const neighbor of graph.neighbors[queue[cursor]!]!) {
      if (!selected.has(neighbor)) { selected.add(neighbor); queue.push(neighbor); }
    }
    // Preserve original snapshot order and aliases, including unopened pages.
    const related: Entry[] = []; const missing: MissingReference[] = [];
    const counts = { incident: 0, repair: 0, verification: 0, renewal: 0 }; let incompleteCount = 0;
    entries.forEach((entry, index) => {
      if (!selected.has(index)) return;
      related.push(entry); counts[entry.type]++; if (incomplete(entry)) incompleteCount++;
      missing.push(...graph!.missing[index]!);
    });
    const privateMode = source.format === 'recued.connection-history.aliases';
    const report: AuthenticationHistoryRelatedBundle['report'] = Object.freeze({
      format: 'recued.connection-history.related', version: 1, privacy_mode: privateMode ? 'aliases' : 'full',
      ...(privateMode ? { alias_scope: 'source_snapshot' as const } : {}),
      evidence: 'retained_local_observations', current_authentication: 'not_checked', coverage: 'source_snapshot_only',
      unrecorded_or_excluded_links: 'not_known', link_rule: 'saved_record_references_both_directions',
      root: Object.freeze({ type: 'incident' as const, id: root.record.id, source_position: incidentIndex + 1 }),
      source_snapshot: Object.freeze({ format: source.format, version: source.version, exported_at: source.exported_at, scope: source.scope, filters: source.filters,
        retention_days: source.retention_days, finished_record_limit: source.finished_record_limit, entry_count: source.entry_count }),
      entry_count: related.length, counts: Object.freeze(counts), entries: Object.freeze(related), incomplete_record_count: incompleteCount,
      missing_reference_count: missing.length, missing_references: Object.freeze(missing),
    });
    return Object.freeze({ filename: snapshot.filename.slice(0, -5) + '-related-incident-' + (incidentIndex + 1) + '.json', report });
  };
};

/** Serialize only on explicit copy or download; never cache JSON per open bundle.
 * Metadata can push a subset over the full snapshot's existing byte ceiling. */
export const prepareAuthenticationHistoryRelatedDownload = (bundle: AuthenticationHistoryRelatedBundle): { filename: string; json: string } => {
  const json = JSON.stringify(bundle.report);
  if (new TextEncoder().encode(json).byteLength > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new Error('Related history bundle is too large.');
  return { filename: bundle.filename, json };
};
