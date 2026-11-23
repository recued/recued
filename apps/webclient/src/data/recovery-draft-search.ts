import type { DraftRecoveryEntry, DraftRecoveryStore } from './draft-recovery.js';
import { selectSearchPassage } from '@recued/contracts';
import type { MailRecoveryStatus } from '../mail/compose-recovery.js';
import { PROMPT_WEEKDAY_NAMES } from '../automation/prompt-repeat.js';

export const SEARCH_OPEN_RECOVERY_DRAFT = 'universal-search-open-recovery-draft';
export const SEARCH_REFRESH_RECOVERY_DRAFTS = 'universal-search-refresh-recovery-drafts';
export const SEARCH_RECOVERY_DRAFT_KEY = 'data-recovery-draft-key';
export const SEARCH_RECOVERY_DRAFT_TOKEN = 'data-recovery-draft-token';
export const RECOVERY_DRAFT_LABELS = { task: 'Task', note: 'Note', project: 'Project', calendar: 'Calendar event', mail: 'Email', reminder: 'Reminder', prompt: 'Scheduled prompt' } as const;
export type RecoveryDraftKind = keyof typeof RECOVERY_DRAFT_LABELS;
export type RecoveryDraftStores = Partial<Record<RecoveryDraftKind, Pick<DraftRecoveryStore<unknown, unknown>, 'list' | 'get' | 'inspect'>>>;
export interface RecoveryDraftMatch {
  kind: RecoveryDraftKind; key: string; token: string; id: string; revision: number; updatedAt: number;
  status: DraftRecoveryEntry['status']; sourceId: string; title: string; excerpt: string; editingExisting: boolean;
  mailStatus?: MailRecoveryStatus;
  reminderKind?: 'alarm' | 'reminder';
}
export interface RecoveryDraftSearchState {
  available: boolean; matches: readonly RecoveryDraftMatch[]; issues: readonly string[]; loading?: boolean;
}
export const recoveryDraftLabel = (match: Pick<RecoveryDraftMatch, 'kind' | 'reminderKind'>): string =>
  match.kind === 'reminder' && match.reminderKind === 'alarm' ? 'Alarm' : RECOVERY_DRAFT_LABELS[match.kind];
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const normalize = (value: string) => value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
const owners = new WeakMap<RecoveryDraftMatch, object>();
const snapshots = new WeakMap<RecoveryDraftMatch, string>();
const excerpt = (body: string, query: string): string => {
  const { text, start, end } = selectSearchPassage(body, query, 220);
  return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
};
/** Read only the already-scoped stores supplied by this paired bootstrap.
 * Draft text is not copied into a second persistence or search index. */
export const searchRecoveryDrafts = (stores: RecoveryDraftStores, query: string): RecoveryDraftSearchState => {
  const words = normalize(query).split(' ').filter(Boolean), matches: RecoveryDraftMatch[] = [], issues: string[] = [];
  for (const kind of Object.keys(RECOVERY_DRAFT_LABELS) as RecoveryDraftKind[]) {
    const store = stores[kind]; if (!store) continue;
    try {
      const read = store.inspect?.() ?? { entries: store.list(), unavailable: false };
      if (read.unavailable) issues.push(RECOVERY_DRAFT_LABELS[kind] + ' recovery copies could not be read. Try Refresh drafts.');
      for (const entry of read.entries) {
        const values = object(entry.values), fields = kind === 'calendar' ? object(values.draft) : values;
        const label = kind === 'reminder' && values.kind === 'alarm' ? 'Alarm' : RECOVERY_DRAFT_LABELS[kind];
        const title = text(fields[kind === 'calendar' ? 'summary' : kind === 'reminder' ? 'text' : 'title']).trim() || 'Untitled ' + label.toLowerCase();
        const body = kind === 'prompt' ? [text(values.prompt), values.mode === 'recurring'
          ? [values.frequency === 'selected_days' ? 'Selected weekdays' : text(values.frequency), values.frequency === 'custom' ? text(values.cron) : text(values.clock),
            values.frequency === 'weekly' ? PROMPT_WEEKDAY_NAMES[Number(values.weekday)] ?? ''
              : values.frequency === 'selected_days' && Array.isArray(values.selectedWeekdays) ? values.selectedWeekdays.map(day => PROMPT_WEEKDAY_NAMES[Number(day)] ?? '').join(' ')
              : values.frequency === 'monthly' ? 'day ' + text(values.monthDay) + ' of each month' : '', text(values.timezone)].join(' ')
          : [text(values.time).replace('T', ' '), text(values.oneOffZone)].join(' '),
          text(values.model).replace('slot_', 'Slot '), values.notify === true ? 'Notify when done' : ''].filter(Boolean).join('\n')
          : kind === 'reminder' ? [text(values.time).replace('T', ' '), text(values.zone)].filter(Boolean).join(' · ')
          : ['body', 'description', 'location'].map(key => text(fields[key])).filter(Boolean).join('\n');
        const friendly = [text(values.calendarName), entry.origin?.label ?? '',
          ...(kind === 'prompt' && entry.original ? [text(object(entry.original).title)] : []),
          ...(kind === 'mail' ? [text(values.mailbox), text(values.recipients)] : []),
          ...(kind === 'reminder' ? [label, values.mail_ref ? 'Email reminder' : text(object(values.record_ref).kind)] : [])].join(' ');
        const searchable = normalize(title + ' ' + body + ' ' + friendly);
        if (!words.every(word => searchable.includes(word))) continue;
        const match: RecoveryDraftMatch = { kind, key: JSON.stringify([kind, entry.id]), token: crypto.randomUUID(), id: entry.id, revision: entry.revision, updatedAt: entry.updatedAt,
          status: entry.status, sourceId: entry.sourceId, title, excerpt: excerpt(body || friendly, query), editingExisting: entry.original !== null,
          ...(kind === 'mail' ? { mailStatus: object(values.mail).status as MailRecoveryStatus } : {}),
          ...(kind === 'reminder' ? { reminderKind: values.kind === 'alarm' ? 'alarm' as const : 'reminder' as const } : {}) };
        owners.set(match, store); snapshots.set(match, JSON.stringify(entry)); matches.push(match);
      }
    } catch { issues.push(RECOVERY_DRAFT_LABELS[kind] + ' recovery copies could not be read. Try Refresh drafts.'); }
  }
  matches.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
  return { available: Object.values(stores).some(Boolean), matches, issues };
};
/** Recheck the displayed revision before navigation and again after loading the
 * destination. Resuming never admits a newer recovery under an older result. */
export const sameRecoveryDraft = (entry: DraftRecoveryEntry | null | undefined, match: RecoveryDraftMatch): boolean =>
  !!entry && entry.id === match.id && entry.revision === match.revision && entry.updatedAt === match.updatedAt
  && entry.status === match.status && entry.sourceId === match.sourceId && (entry.original !== null) === match.editingExisting;
export const resolveRecoveryDraft = (stores: RecoveryDraftStores, match: RecoveryDraftMatch): DraftRecoveryEntry | null => {
  try {
    if (owners.get(match) !== stores[match.kind]) return null;
    const entry = stores[match.kind]?.get(match.id);
    return sameRecoveryDraft(entry, match) && JSON.stringify(entry) === snapshots.get(match) ? entry! : null;
  }
  catch { return null; }
};
