import type { Commitment, ContactRecord, SourceRegistration, WorkEntityGetRpcResponse } from '@recued/contracts';
import type { DataContactGetCaller, DataWorkEntityGetCaller } from './bootstrap-data-route.js';
import { createNoteRelatedRecords, type NoteRelatedTarget } from './note-related-records.js';
import { contactReferencePreview, workReferencePreview, type ReferencePreview } from './work-reference-preview.js';

export const commitmentRelatedIdentity = (entity: Pick<Commitment, 'id' | 'source_id' | 'source_record_id' | 'created_at'>): string =>
  JSON.stringify([entity.id, entity.source_id, entity.source_record_id ?? null, entity.created_at]);

/** A bounded related-record reader. Preview and Open both recheck the selected
 * record's lifetime; neither changes a relationship or a record. */
export const createCommitmentRelatedRecords = (deps: {
  contact?: DataContactGetCaller; resolveContact?: (args: { email: string }) => Promise<{ contact?: ContactRecord | null }>; work?: DataWorkEntityGetCaller;
  sources(): readonly SourceRegistration[]; now?: () => number; active(): boolean; changed(): void;
}) => {
  const model = createNoteRelatedRecords({
    ...(deps.contact ? { contact: id => deps.contact!({ email: id }) } : {}),
    ...(deps.resolveContact ? { resolveContact: id => deps.resolveContact!({ email: id }) } : {}),
    ...(deps.work ? { project: id => deps.work!({ kind: 'project', id }), task: id => deps.work!({ kind: 'task', id }) } : {}),
    sources: deps.sources, now: deps.now, active: deps.active, pageAllKinds: true, protectKnownIdentity: true, changed: deps.changed,
  });
  let binding = '', generation = 0, expanded: string | null = null, previewing: string | null = null;
  const preview = (target: NoteRelatedTarget): ReferencePreview => target.kind === 'contact' ? contactReferencePreview(target.contact)
    : workReferencePreview(target.kind, target.kind === 'task' ? target.task.id : target.project.id,
      { entity: target.kind === 'task' ? target.task : target.project, source_freshness: target.source_freshness }, deps.sources());
  return {
    reset() { generation++; binding = ''; expanded = previewing = null; model.reset(); },
    open(entity: Commitment, snapshot?: Pick<WorkEntityGetRpcResponse, 'source_freshness'>) {
      const next = JSON.stringify([commitmentRelatedIdentity(entity), entity.counterparty_contact_id, entity.blocks_task_ids, entity.blocks_project_ids]);
      if (next !== binding) { generation++; expanded = previewing = null; binding = next; }
      model.open({ ...entity, _kind: 'commitment', related_contact_ids: entity.counterparty_contact_id ? [entity.counterparty_contact_id] : [],
        related_project_ids: entity.blocks_project_ids }, snapshot);
    },
    view() {
      const view = model.view();
      return { more: view.more, records: view.records.map(row => {
        const target = model.inspect(row.key);
        let details: ReferencePreview | undefined;
        let previewError: string | undefined;
        if (target) {
          try {
            const saved = preview(target);
            details = { ...saved, fields: saved.fields.map(([label, value]) => [label === 'Status' ? 'Saved status' : label, value]) };
            if (row.task && (!row.task.current || row.task.pending)) details.notice = ['The task’s status is unconfirmed.', details.notice].filter(Boolean).join(' ');
          } catch { previewError = 'These saved details could not be confirmed. Close the preview and try again.'; }
        }
        return { ...row, can_open: !!deps.work && row.state === 'ready', previewing: previewing === row.key,
          expanded: expanded === row.key, preview: expanded === row.key && previewing !== row.key ? details : undefined,
          preview_error: previewError,
          status: row.task && (!row.task.current || row.task.pending) ? 'Status unconfirmed' : details?.fields.find(([label]) => label === 'Saved status')?.[1],
          ...(row.kind === 'contact' ? { subtitle: details?.fields.find(([label]) => label === 'Email')?.[1] } : {}),
        };
      }) };
    },
    load: model.load, more: model.more, retry: model.retry,
    refresh() { generation++; previewing = null; model.refreshAll(); },
    async preview(key: string): Promise<void> {
      if (!deps.active()) return;
      if (expanded === key) { expanded = previewing = null; generation++; deps.changed(); return; }
      const revision = ++generation; expanded = previewing = key; deps.changed();
      await model.activate(key);
      if (revision !== generation || !deps.active()) return;
      previewing = null; deps.changed();
    },
    closePreview(): string | null {
      const key = expanded; expanded = previewing = null; generation++; deps.changed(); return key;
    },
    expandedKey: () => expanded,
    activate: model.activate,
  };
};
export type CommitmentRelatedView = ReturnType<ReturnType<typeof createCommitmentRelatedRecords>['view']>;
