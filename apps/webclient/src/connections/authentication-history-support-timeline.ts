import { AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES, type AuthenticationHistoryExportMode } from '@recued/contracts';
import type { AuthenticationHistoryRelatedBundle } from './authentication-history-related-bundle.js';
import type { AuthenticationHistoryRecordContext } from './authentication-history-record-context.js';
import { previewRecordTypes as types, previewRecordedOutcomes as outcomes } from './authentication-history-preview-fields.js';

type Entry = AuthenticationHistoryRelatedBundle['report']['entries'][number];
export type AuthenticationHistorySupportSource = { bundle: AuthenticationHistoryRelatedBundle }
  | { entry: Entry; representation: AuthenticationHistoryExportMode; context?: AuthenticationHistoryRecordContext };
const eventLabels = { opened: 'Problem first recorded', recorded: 'Earlier alert state added to history', changed: 'Reported problem or affected uses changed',
  awaiting_confirmation: 'No current problem recorded; waiting for access evidence', recovered: 'Recovery recorded', retired: 'Closed without confirmed recovery' } as const;
const levels = { review: 'Access or configuration needs review', rejected: 'Access was rejected', expiry_30: 'Secret date within 30 days', expiry_7: 'Secret date within 7 days', expiry_passed: 'Recorded secret date reached' } as const;
const actions = { reauthorize: 'Reauthorize', switch_oauth_app: 'Switch OAuth app', switch_authentication: 'Switch authentication', rotate_secret: 'Rotate saved-app secret', replace_credentials: 'Replace credentials', change_permissions: 'Change permissions' } as const;
const checks = { api_read: 'API read', collection_read: 'Mail/Calendar read', file_metadata: 'File metadata read', file_download: 'File download/export read', write_permissions: 'Write permission evidence (no write performed)' } as const;
const method = (type: string): string => type === 'direct_oauth' ? 'Recued direct OAuth' : type === 'broker' ? 'Broker sign-in' : type === 'other' ? 'Saved credentials' : 'Unknown authentication';
// Keep saved labels on one literal line, including bidi and line controls. The
// output is plain text; these values cannot become structural timeline entries.
const literal = (value: string): string => JSON.stringify(value).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
  char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
const words = (value: string): string => value.replace(/_/g, ' ').replace(/^./, char => char.toUpperCase());
const incomplete = (entry: Entry): boolean => Object.entries(entry.record).some(([key, value]) => value === true
  && ['events_truncated', 'details_truncated', 'targets_truncated', 'incidents_truncated', 'incomplete', 'references_incomplete'].includes(key));

/** Use only checked immutable preview data. Preserve original aliases rather
 * than re-aliasing a subset. Only named saved fields enter the text. */
export const prepareAuthenticationHistorySupportTimeline = (source: AuthenticationHistorySupportSource): { readonly text: string; readonly bytes: number; readonly records: number; readonly observations: number } => {
  const bundle = 'bundle' in source ? source.bundle.report : undefined;
  const entries = bundle ? bundle.entries : 'entry' in source ? [source.entry] : [];
  const root = bundle ? entries.find(entry => entry.type === 'incident' && entry.record.id === bundle.root.id) : entries[0];
  if (!root || root.type !== 'incident' || !('events' in root.record)) throw new Error('Choose a saved incident.');
  const representation = bundle?.privacy_mode ?? ('representation' in source ? source.representation : undefined);
  if (representation !== 'aliases' && representation !== 'full') throw new Error('Choose a record privacy mode.');
  const context = bundle ? { source_snapshot: bundle.source_snapshot, source_position: bundle.root.source_position } : 'context' in source ? source.context : undefined;
  const lines: string[] = []; const encoder = new TextEncoder(); let bytes = 0; let reservedLines = 0;
  const reserve = (line: string): void => {
    bytes += encoder.encode(line).byteLength + (reservedLines++ ? 1 : 0);
    if (bytes > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new Error('Support timeline is too large.');
  };
  const add = (line = ''): void => { reserve(line); lines.push(line); };
  const observations: { at: number; line: string; order: number }[] = [];
  const observe = (at: number, entry: Entry, text: string): void => {
    const line = new Date(at).toISOString() + ' | ' + types[entry.type] + ' ' + literal(entry.record.id) + ' | ' + text;
    reserve(line); observations.push({ at, line, order: observations.length });
  };
  add('Recued incident support timeline');
  add('Root incident: ' + literal(root.record.id));
  add('Privacy: ' + (representation === 'aliases' ? 'aliases. Original aliases are preserved; matching aliases from separate files do not establish a link.' : 'names and IDs (local use). Review before sharing.'));
  add('Saved observations and source claims only. Current vendor access was not checked.');
  add('Repairs, read checks, token renewal and recovery are separate evidence. Their order does not establish causation.');
  add('Read checks do not verify sending, editing, all resources or future work. A passed token-renewal check covers issuance/saving only.');
  add('This readable summary omits fields. Use the saved JSON for all retained fields.');
  add(bundle ? 'Coverage: incident and records connected by saved references in this snapshot. Shared repairs may include other incidents.' : 'Coverage: one saved incident. Other records are not included; their references cannot be discovered here.');
  if (context) {
    const snapshot = context.source_snapshot;
    add('Source snapshot captured (UTC): ' + new Date(snapshot.exported_at).toISOString());
    add('Source entries: ' + snapshot.entry_count + '. Retention: ' + snapshot.retention_days + ' days; finished-record limit: ' + snapshot.finished_record_limit + '.');
    add('Source position: ' + (context.source_position === undefined ? 'unknown.' : context.source_position + '.'));
    const scope = snapshot.scope;
    add('Source scope: ' + words(scope.kind) + (scope.kind === 'connection' ? ' ' + literal(scope.name) : scope.kind === 'collection' ? ' ' + scope.platform + ' ' + literal(scope.slug) : scope.kind === 'file_source' ? ' ' + literal(scope.source_id) : scope.kind === 'group' ? ' ' + literal(scope.id) : '') + '.');
    const filters = snapshot.filters;
    const applied = [filters.type ? 'type ' + filters.type : '', filters.outcome ? 'outcome ' + filters.outcome : '', filters.from ? 'from ' + filters.from : '', filters.through ? 'through ' + filters.through : '', ('search' in filters && filters.search) || ('search_applied' in filters && filters.search_applied) ? 'search applied (text omitted)' : ''].filter(Boolean);
    add('Applied source filters: ' + (applied.length ? applied.join('; ') + '.' : 'none.'));
  } else add('Source snapshot details are unknown: capture date, scope, filters, retention and source position.');
  add('Included saved records: ' + entries.length + '. Records with saved incomplete-detail flags: ' + entries.filter(incomplete).length + '. Zero does not establish complete history.');
  add(bundle ? 'Missing saved references: ' + bundle.missing_reference_count + '. Unrecorded or excluded links are unknown.' : 'Other saved references and missing records are unknown.');
  add(); add('Saved record summaries');
  for (const entry of entries) {
    const r = entry.record; const name = types[entry.type] + ' ' + literal(r.id);
    add('- ' + name + ': ' + outcomes[entry.outcome] + '.');
    if ('group' in r) {
      if (representation === 'full' && 'label' in r.group) add('  Saved account/app label: ' + literal(r.group.label));
      add('  Recorded issue codes: ' + (r.group.issues.length ? r.group.issues.map(issue => issue.code).join(', ') : 'none retained') + '. Affected uses retained: ' + r.group.uses.length + (r.group.usage_available ? '.' : '; usage inventory unavailable.'));
      if (r.retirement_reason) add('  Closed reason: ' + words(r.retirement_reason) + '.');
      if (r.status === 'recovered' && !r.recovery_evidence) add('  Recovery is recorded; successful-operation times were not retained.');
      observe(r.started_at, entry, 'First problem observation retained.');
      if (r.history_started_at !== r.started_at) observe(r.history_started_at, entry, 'History recording began; earlier times came from saved state.');
      if (r.last_problem_at !== undefined && r.last_problem_at !== r.started_at) observe(r.last_problem_at, entry, 'Last problem observation retained.');
      for (const event of r.events) observe(event.at, entry, eventLabels[event.kind] + (['opened', 'recorded', 'changed'].includes(event.kind) ? ' — ' + levels[event.level] : '') + '.');
      if (r.ended_at !== undefined && !r.events.some(event => event.at === r.ended_at && (event.kind === 'retired' || event.kind === 'recovered'))) observe(r.ended_at, entry, 'Saved incident ended: ' + outcomes[entry.outcome] + '.');
      if (r.recovery_evidence) {
        observe(r.recovery_evidence.earliest_at, entry, 'Earliest retained successful-operation evidence.');
        if (r.recovery_evidence.latest_at !== r.recovery_evidence.earliest_at) observe(r.recovery_evidence.latest_at, entry, 'Latest retained successful-operation evidence.');
      }
    } else if ('action' in r) {
      add('  Repair action: ' + actions[r.action] + '.');
      if (r.from || r.to) add('  Authentication route: ' + (r.from ? method(r.from.type) : 'Unknown authentication') + ' -> ' + (r.to ? method(r.to.type) : 'Unknown authentication') + '.');
      if (r.reason) add('  Saved refusal: ' + words(r.reason) + '.');
      observe(r.started_at, entry, 'Repair started: ' + actions[r.action] + '.');
      if (r.finished_at !== undefined) observe(r.finished_at, entry, outcomes[entry.outcome] + '. Applied does not establish recovery.');
    } else if ('selection' in r) {
      for (const [kind, label] of Object.entries(checks)) {
        const results = r.results.flatMap(result => result.checks.filter(check => check.kind === kind));
        if (results.length) {
          add('  ' + label + ': ' + ['passed', 'failed', 'unconfirmed'].map(status => results.filter(check => check.status === status).length + ' ' + status).join(', ') + '.');
          const reasons = [...new Set(results.flatMap(check => check.reason ? [words(check.reason)] : []))];
          if (reasons.length) add('  Reasons retained: ' + reasons.join(', ') + '.');
        }
      }
      add('  Check counts refer to saved checks, not accounts.');
      observe(r.started_at, entry, 'Access checks started.');
      if (r.finished_at !== undefined) observe(r.finished_at, entry, outcomes[entry.outcome] + '. Only the recorded checks are covered.');
    } else if ('issuer' in r) {
      add('  Token issuer: ' + (r.issuer === 'google' ? 'Google' : 'Microsoft') + '.');
      if (representation === 'full' && 'app_label' in r) add('  Saved app label: ' + literal(r.app_label));
      add('  Token-renewal results: ' + ['passed', 'failed', 'unconfirmed'].map(status => r.results.filter(result => result.status === status).length + ' ' + status).join(', ') + '.');
      observe(r.started_at, entry, 'Token-renewal checks started.');
      if (r.finished_at !== undefined) observe(r.finished_at, entry, outcomes[entry.outcome] + '. Protected-resource access was not established by renewal.');
      if (r.history_started_at !== r.started_at) observe(r.history_started_at, entry, 'Earlier token-renewal receipt added to history.');
    }
  }
  add(); add('Timeline (UTC; equal-time order has no additional meaning)');
  observations.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const observation of observations) lines.push(observation.line); // Already reserved before sorting.
  const text = lines.join('\n');
  return Object.freeze({ text, bytes, records: entries.length, observations: observations.length });
};
