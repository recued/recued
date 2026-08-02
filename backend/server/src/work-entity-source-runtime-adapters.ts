/** Executable landing adapters for every pack-declarable work-entity kind.
 *
 * The contract package owns the declarable keys. This registry is an exact
 * mapped type over those keys and carries the runtime operations a declaration
 * needs to be real: canonical projection finalization, mirror-table identity,
 * canonical upsert/preservation, read, and tombstone. Widening the manifest
 * contract without implementing an adapter is therefore a compile error, not a
 * green pack whose records have nowhere to land. */

import type {
  Note,
  Project,
  ProjectState,
  Task,
  TaskPriority,
  WorkEntitySourceDeclarableKind,
} from '@recued/contracts';

import type {
  NoteWriteInput,
  ProjectWriteInput,
  TaskWriteInput,
  WorkEntityStore,
} from './storage/work-entity-store.js';

export interface WorkEntitySourceProjectedIdentity {
  source_id: string;
  source_record_id: string;
  connection_id: string;
  source_updated_at?: number;
  source_version_token?: string;
  source_record_hash: string;
  source_extension_blob?: Record<string, unknown>;
}

export type ProjectedWorkEntityUpsert =
  | { kind: 'task'; write: TaskWriteInput & { source_record_id: string } }
  | { kind: 'project'; write: ProjectWriteInput & { source_record_id: string } }
  | { kind: 'note'; write: NoteWriteInput & { source_record_id: string } };

type ProjectedByKind = {
  [K in WorkEntitySourceDeclarableKind]: Extract<ProjectedWorkEntityUpsert, { kind: K }>;
};

type EntityByKind = {
  task: Task;
  note: Note;
  project: Project;
};

export interface WorkEntitySourceRuntimeAdapter<K extends WorkEntitySourceDeclarableKind> {
  readonly kind: K;
  readonly table: `data_${K}`;
  project(
    identity: WorkEntitySourceProjectedIdentity,
    canonical: Readonly<Record<string, unknown>>,
  ): ProjectedByKind[K];
  read(store: WorkEntityStore, id: string): EntityByKind[K] | null;
  upsert(
    store: WorkEntityStore,
    write: ProjectedByKind[K]['write'],
    existingId: string | null,
    now: number,
  ): EntityByKind[K];
  tombstone(store: WorkEntityStore, id: string, now: number): boolean;
}

type RuntimeAdapterRegistry = {
  [K in WorkEntitySourceDeclarableKind]: WorkEntitySourceRuntimeAdapter<K>;
};

export const WORK_ENTITY_SOURCE_RUNTIME_ADAPTERS = {
  task: {
    kind: 'task',
    table: 'data_task',
    project(identity, canonical) {
      return {
        kind: 'task',
        write: {
          ...identity,
          title: canonical.title as string,
          ...(canonical.done !== undefined ? { done: canonical.done as boolean } : {}),
          ...(canonical.state !== undefined ? { state: canonical.state as string } : {}),
          ...(canonical.progress !== undefined ? { progress: canonical.progress as number } : {}),
          ...(canonical.due_at !== undefined ? { due_at: canonical.due_at as number } : {}),
          ...(canonical.priority !== undefined
            ? { priority: canonical.priority as TaskPriority }
            : {}),
          ...(canonical.completed_at !== undefined
            ? { completed_at: canonical.completed_at as number }
            : {}),
        },
      };
    },
    read: (store, id) => store.readTask(id),
    upsert(store, input, existingId, now) {
      let write: TaskWriteInput = input;
      if (existingId !== null) {
        write = { ...write, id: existingId };
        const existing = store.readTask(existingId);
        if (existing !== null) {
          // Vendor projection owns only declared canonical lanes. Preserve every
          // local-only lane when folding onto an existing row.
          if (write.body === undefined) write.body = existing.body;
          if (write.assigned_contact_id === undefined) {
            write.assigned_contact_id = existing.assigned_contact_id;
          }
          if (write.parent_calendar_event_id === undefined) {
            write.parent_calendar_event_id = existing.parent_calendar_event_id;
          }
          if (write.linked_mail_thread_id === undefined) {
            write.linked_mail_thread_id = existing.linked_mail_thread_id;
          }
          if (write.parent_project_id === undefined) {
            write.parent_project_id = existing.parent_project_id;
          }
          if (write.blocks_task_ids === undefined) {
            write.blocks_task_ids = existing.blocks_task_ids;
          }
        }
      }
      return store.writeTask(write, now);
    },
    tombstone: (store, id, now) => store.deleteTask(id, { tombstone: true, now }),
  },

  note: {
    kind: 'note',
    table: 'data_note',
    project(identity, canonical) {
      return {
        kind: 'note',
        write: {
          ...identity,
          // Meta Sources never put remote text in the canonical long-body
          // column; the bounded excerpt stays in the fidelity-marked preview.
          body: '',
          ...(typeof canonical.title === 'string' && canonical.title.length > 0
            ? { title: canonical.title }
            : {}),
        },
      };
    },
    read: (store, id) => store.readNote(id),
    upsert(store, input, existingId, now) {
      let write: NoteWriteInput = input;
      if (existingId !== null) {
        write = { ...write, id: existingId };
        const existing = store.readNote(existingId);
        if (existing !== null) {
          if (write.body.length === 0) write.body = existing.body;
          if (write.title === undefined) write.title = existing.title;
          if (write.related_contact_ids === undefined) {
            write.related_contact_ids = existing.related_contact_ids;
          }
          if (write.related_calendar_event_ids === undefined) {
            write.related_calendar_event_ids = existing.related_calendar_event_ids;
          }
          if (write.related_mail_thread_ids === undefined) {
            write.related_mail_thread_ids = existing.related_mail_thread_ids;
          }
          if (write.related_project_ids === undefined) {
            write.related_project_ids = existing.related_project_ids;
          }
          // A sync fold is not a user action.
          if (write.last_user_action_at === undefined) {
            write.last_user_action_at = existing.last_user_action_at;
          }
        }
      }
      return store.writeNote(write, now);
    },
    tombstone: (store, id, now) => store.deleteNote(id, { tombstone: true, now }),
  },

  project: {
    kind: 'project',
    table: 'data_project',
    project(identity, canonical) {
      return {
        kind: 'project',
        write: {
          ...identity,
          title: canonical.title as string,
          ...(canonical.state !== undefined
            ? { state: canonical.state as ProjectState }
            : {}),
          ...(canonical.target_completion_at !== undefined
            ? { target_completion_at: canonical.target_completion_at as number }
            : {}),
        },
      };
    },
    read: (store, id) => store.readProject(id),
    upsert(store, input, existingId, now) {
      let write: ProjectWriteInput = input;
      if (existingId !== null) {
        write = { ...write, id: existingId };
        const existing = store.readProject(existingId);
        if (existing !== null) {
          if (write.description === undefined) write.description = existing.description;
          if (write.related_contact_ids === undefined) {
            write.related_contact_ids = existing.related_contact_ids;
          }
          if (write.parent_project_id === undefined) {
            write.parent_project_id = existing.parent_project_id;
          }
          if (write.last_activity_at === undefined) {
            write.last_activity_at = existing.last_activity_at;
          }
        }
      }
      return store.writeProject(write, now);
    },
    tombstone: (store, id, now) => store.deleteProject(id, { tombstone: true, now }),
  },
} satisfies RuntimeAdapterRegistry;

const runtimeAdapterRegistry: RuntimeAdapterRegistry =
  WORK_ENTITY_SOURCE_RUNTIME_ADAPTERS;

export const WORK_ENTITY_SOURCE_RUNTIME_ADAPTER_KINDS = Object.freeze(
  Object.keys(WORK_ENTITY_SOURCE_RUNTIME_ADAPTERS) as WorkEntitySourceDeclarableKind[],
);

export const workEntitySourceRuntimeAdapter = <K extends WorkEntitySourceDeclarableKind>(
  kind: K,
): WorkEntitySourceRuntimeAdapter<K> => runtimeAdapterRegistry[kind];

export const readWorkEntitySourceRuntimeRow = (
  kind: WorkEntitySourceDeclarableKind,
  store: WorkEntityStore,
  id: string,
): Task | Note | Project | null => runtimeAdapterRegistry[kind].read(store, id);

export const upsertWorkEntitySourceRuntimeRow = (
  store: WorkEntityStore,
  input: ProjectedWorkEntityUpsert,
  existingId: string | null,
  now: number,
): Task | Note | Project => {
  switch (input.kind) {
    case 'task':
      return runtimeAdapterRegistry.task.upsert(store, input.write, existingId, now);
    case 'note':
      return runtimeAdapterRegistry.note.upsert(store, input.write, existingId, now);
    case 'project':
      return runtimeAdapterRegistry.project.upsert(store, input.write, existingId, now);
  }
};

export const tombstoneWorkEntitySourceRuntimeRow = (
  kind: WorkEntitySourceDeclarableKind,
  store: WorkEntityStore,
  id: string,
  now: number,
): boolean => runtimeAdapterRegistry[kind].tombstone(store, id, now);
