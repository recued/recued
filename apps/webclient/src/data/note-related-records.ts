import { isMentionOnlyEmail, type ContactRecord, type ContactAdditionalIdentifiers, type Note, type SourceRegistration,
  type WorkEntity, type WorkEntityGetRpcResponse, type WorkEntitySourceFreshness } from '@recued/contracts';
import type { NoteRelatedRecordView } from '@recued/ui-shared/work-entity-page';
import { dependencySummary, taskDependency, taskSourceStatus, type TaskDependency } from './task-blockers.js';

type Project = Extract<WorkEntity, { _kind: 'project' }>;
type Task = Extract<WorkEntity, { _kind: 'task' }>;
type ContactReply = { contact: ContactRecord | null; identifiers?: ContactAdditionalIdentifiers };
export type NoteRelatedTarget =
  | { kind: 'contact'; identity: string; contact: ContactRecord; identifiers?: ContactAdditionalIdentifiers }
  | { kind: 'project'; identity: string; project: Project; source_freshness?: WorkEntitySourceFreshness }
  | { kind: 'task'; identity: string; task: Task; status: TaskDependency; source_freshness?: WorkEntitySourceFreshness };
type RecordRow = NoteRelatedRecordView & { id: string; requested: boolean; sequence: number; target?: NoteRelatedTarget; taskValue?: TaskDependency };
type Owner = Pick<Note, 'id' | 'source_id' | 'source_record_id' | 'created_at' | 'related_contact_ids' | 'related_project_ids'>
  & Partial<Pick<Task, 'blocks_task_ids' | 'sync_state' | 'pending_write'>>
  & { _kind?: 'note' | 'task' | 'commitment' };
type Snapshot = { source_freshness?: WorkEntitySourceFreshness };
const PAGE_SIZE = 20;

/** Lazy, bounded reads of canonical relationships. Activation rechecks identity;
 * uncertain task completion never clears a dependency. */
export const createNoteRelatedRecords = (deps: {
  contact?: (id: string) => Promise<ContactReply>;
  resolveContact?: (id: string) => Promise<{ contact?: ContactRecord | null }>;
  project?: (id: string) => Promise<WorkEntityGetRpcResponse>;
  task?: (id: string) => Promise<WorkEntityGetRpcResponse>;
  sources?: () => readonly SourceRegistration[];
  now?: () => number;
  active?: () => boolean;
  pageAllKinds?: boolean;
  protectKnownIdentity?: boolean;
  changed: () => void;
}) => {
  let binding = '', generation = 0, visible = PAGE_SIZE;
  let rows: RecordRow[] = [], owner: Owner | undefined, snapshot: Snapshot | undefined;
  let ownerUnconfirmed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let activeReads = 0;
  const readSlots: Array<() => void> = [];
  const now = deps.now ?? Date.now, sources = () => deps.sources?.() ?? [];
  const clearExpiry = () => { if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined; };
  const reset = () => { generation++; clearExpiry(); binding = ''; rows = []; visible = PAGE_SIZE; owner = undefined; snapshot = undefined; ownerUnconfirmed = false; };
  const shown = () => !deps.pageAllKinds && rows.some(row => row.kind === 'task')
    ? rows.filter(row => row.kind !== 'task').concat(rows.filter(row => row.kind === 'task').slice(0, visible)) : rows.slice(0, visible);
  const ownerStatus = () => owner && taskSourceStatus(owner.source_id, snapshot?.source_freshness, sources(), now());
  const scheduleExpiry = () => {
    clearExpiry();
    if (!rows.some(row => row.kind === 'task')) return;
    const time = now(), expiries = [ownerStatus()?.expiresAt, ...rows.map(row => row.taskValue?.expiresAt)]
      .filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= time);
    if (!expiries.length) return;
    expiryTimer = setTimeout(() => { expiryTimer = undefined; if (deps.active?.() !== false) deps.changed(); scheduleExpiry(); },
      Math.min(60_000, Math.max(1, Math.min(...expiries) - time + 1)));
  };
  const changed = () => { scheduleExpiry(); deps.changed(); };
  const currentTask = (row: RecordRow): TaskDependency => {
    if (row.state !== 'ready' || !row.taskValue) return { state: row.state === 'loading' ? 'loading' : row.state === 'missing' ? 'missing' : 'error', title: row.label, source: '' };
    const value = row.taskValue;
    return { ...value, current: value.current && (value.expiresAt === undefined || now() <= value.expiresAt),
      source: sources().find(source => source.id === value.sourceId)?.source_label || value.source };
  };
  const read = async (row: RecordRow): Promise<NoteRelatedTarget | null> => {
    if (row.kind === 'contact') {
      if (!deps.contact) throw new Error('Contacts cannot be opened here.');
      let result = await deps.contact(row.id);
      if ((!result.contact || result.contact.merged_into !== undefined) && deps.resolveContact && row.id.includes('@')) {
        const found = (await deps.resolveContact(row.id)).contact;
        if (found && found.merged_into === undefined) result = await deps.contact(found.contact_id ?? found.email);
      }
      const contact = result.contact;
      if (!contact || contact.merged_into !== undefined) return null;
      return { kind: 'contact', contact, ...(result.identifiers ? { identifiers: result.identifiers } : {}),
        identity: JSON.stringify([contact.contact_id ?? contact.email, contact.created_at]) };
    }
    if (row.kind === 'task') {
      if (row.id === owner?.id && owner?._kind !== 'commitment') throw new Error('This task depends on itself.');
      if (!deps.task) throw new Error('Tasks cannot be opened here.');
      const response = await deps.task(row.id), status = taskDependency(row.id, response, sources(), now());
      if (status.state === 'missing' || response.entity?._kind !== 'task') return null;
      const task = response.entity;
      return { kind: 'task', task, status, source_freshness: response.source_freshness,
        identity: JSON.stringify([task.id, task.source_id, task.source_record_id ?? null, task.created_at]) };
    }
    if (!deps.project) throw new Error('Projects cannot be opened here.');
    const response = await deps.project(row.id), project = response.entity;
    if (!project || project._kind !== 'project' || project.id !== row.id || project.deleted_at != null || project.sync_state === 'tombstoned' || project.sync_state === 'orphaned') return null;
    if (project.sync_state !== 'live') throw new Error('This project’s source is unavailable. Try again when it is connected.');
    return { kind: 'project', project, source_freshness: response.source_freshness,
      identity: JSON.stringify([project.id, project.source_id, project.source_record_id ?? null, project.created_at]) };
  };
  const readCurrent = async (row: RecordRow, revision: number, sequence: number) => {
    if (activeReads >= 4) await new Promise<void>(resolve => readSlots.push(resolve)); else activeReads++;
    try { return revision === generation && sequence === row.sequence ? await read(row) : undefined; }
    finally { const next = readSlots.shift(); if (next) next(); else activeReads--; }
  };
  const label = (target: NoteRelatedTarget): string => target.kind === 'project' ? target.project.title : target.kind === 'task' ? target.status.title
    : target.contact.name?.trim() || (!isMentionOnlyEmail(target.contact.email) ? target.contact.email : 'Contact');
  const failure = (row: RecordRow, error: unknown) => {
    row.state = 'unavailable'; row.opening = false;
    row.message = error instanceof Error && ['Contacts cannot be opened here.', 'Projects cannot be opened here.', 'Tasks cannot be opened here.',
      'This project’s source is unavailable. Try again when it is connected.', 'This task depends on itself.',
      'The linked task changed. Try again to check it.'].includes(error.message) ? error.message : `Could not load this ${row.kind}. Try again.`;
  };
  const install = (row: RecordRow, target: NoteRelatedTarget | null) => {
    row.target = target ?? undefined; row.state = target ? 'ready' : 'missing'; row.opening = false;
    row.taskValue = target?.kind === 'task' ? target.status : undefined;
    row.message = target ? undefined : `This ${row.kind} is no longer available.`;
    if (target) row.label = label(target);
  };
  const load = async (key?: string) => {
    const revision = generation;
    const pending = shown().filter(row => !row.requested && (key === undefined || row.key === key)).map(row => {
      row.requested = true; row.state = 'loading'; row.message = undefined;
      return { row, sequence: ++row.sequence };
    });
    const worker = async () => {
      for (;;) {
        const job = pending.shift(); if (!job || revision !== generation) return;
        const { row, sequence } = job; if (row.sequence !== sequence) continue;
        try { const target = await readCurrent(row, revision, sequence); if (revision !== generation) return; if (row.sequence !== sequence || target === undefined) continue;
          if (deps.protectKnownIdentity && target && row.target && target.identity !== row.target.identity) throw new Error('The linked record changed.');
          install(row, target); }
        catch (error) { if (revision !== generation) return; if (row.sequence !== sequence) continue; failure(row, error); }
        changed();
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  };
  return {
    reset,
    open(entity: Owner, readSnapshot?: Snapshot) {
      const contacts = [...new Set(entity.related_contact_ids)], projects = [...new Set(entity.related_project_ids)], tasks = [...new Set(entity.blocks_task_ids ?? [])];
      const next = JSON.stringify([entity.id, entity.source_id, entity.source_record_id, entity.created_at, contacts, projects, tasks]);
      const sameOwner = owner && entity.id === owner.id && entity.source_id === owner.source_id
        && entity.source_record_id === owner.source_record_id && entity.created_at === owner.created_at;
      const previousSnapshot = sameOwner ? snapshot : undefined, previousUnconfirmed = !!sameOwner && ownerUnconfirmed;
      if (next !== binding) {
        reset(); binding = next;
        rows = (['contact', 'project', 'task'] as const).flatMap(kind => (kind === 'contact' ? contacts : kind === 'project' ? projects : tasks)
          .map((id, index): RecordRow => ({ key: `${kind}:${id}`, id, kind, label: `Linked ${kind} ${index + 1}`, state: 'loading', requested: false, sequence: 0 })));
      }
      owner = entity; snapshot = readSnapshot ?? previousSnapshot;
      ownerUnconfirmed = readSnapshot === undefined && previousUnconfirmed;
      scheduleExpiry();
    },
    view: () => ({ records: shown().map((row): NoteRelatedRecordView => {
      const { id: _id, target, requested: _requested, sequence: _sequence, taskValue: _taskValue, ...view } = row;
      if (view.kind !== 'task') return view;
      const value = currentTask(row);
      return { ...view, can_open: target?.kind === 'task' && view.state !== 'missing' && view.state !== 'unavailable',
        ...(value.state === 'ready' ? { task: { source: value.source, done: value.done === true, current: value.current === true, pending: value.pending === true } } : {}) };
    }), more: shown().length < rows.length }),
    dependencies() {
      const uncertain = ownerUnconfirmed || !!owner && (owner.sync_state !== 'live' || !!owner.pending_write || ownerStatus()?.current !== true);
      return { summary: dependencySummary(rows.filter(row => row.kind === 'task').map(currentTask), uncertain), uncertain };
    },
    load,
    inspect(key: string): NoteRelatedTarget | undefined {
      const row = rows.find(item => item.key === key);
      return row?.state === 'ready' ? row.target : undefined;
    },
    refreshAll() {
      for (const row of rows) { row.sequence++; row.requested = false; row.state = 'loading'; row.opening = false; row.message = undefined; }
      scheduleExpiry();
    },
    more() { visible += PAGE_SIZE; changed(); void load(); },
    refreshTasks(options: { owner?: boolean } = {}) {
      if (options.owner) ownerUnconfirmed = true;
      for (const row of rows) if (row.kind === 'task') { row.sequence++; row.requested = false; row.state = 'loading'; row.opening = false; row.message = undefined; }
      scheduleExpiry();
    },
    retry(key: string) {
      const row = rows.find(item => item.key === key);
      if (!row || !['missing', 'unavailable'].includes(row.state)) return;
      row.sequence++; row.requested = false; row.target = undefined; row.message = undefined; row.state = 'loading';
      changed(); void load(key);
    },
    async activate(key: string): Promise<NoteRelatedTarget | null> {
      const row = rows.find(item => item.key === key), revision = generation;
      if (!row || row.state !== 'ready' || !row.target || row.opening) return null;
      const identity = row.target.identity, sequence = ++row.sequence;
      row.opening = true; changed();
      try {
        const target = await readCurrent(row, revision, sequence);
        if (revision !== generation || sequence !== row.sequence || target === undefined) return null;
        if (target && target.identity !== identity) throw new Error(row.kind === 'task' ? 'The linked task changed. Try again to check it.' : 'The linked record changed.');
        install(row, target); changed(); return target;
      } catch (error) {
        if (revision === generation && sequence === row.sequence) { failure(row, error); changed(); }
        return null;
      }
    },
  };
};
