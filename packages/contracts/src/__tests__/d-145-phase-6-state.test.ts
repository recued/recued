/** D-145 PA6 — work-entity page state machine.
 *
 *  Pin per § Phase PA6 (Source switching, list/search, create flow,
 *  per-item edit flow):
 *    - initial state defaults
 *    - selectKindTransition: clears search + dialog + selected source
 *    - selectSourceTransition: maps sentinel to null; clears search;
 *      preserves dialog
 *    - applySearchTransition: pure update
 *    - openCreateDialogTransition / openEditDialogTransition: dialog
 *      state seeded correctly
 *    - setDialogValuesTransition / setDialogErrorsTransition /
 *      setDialogSubmittingTransition / setDialogSubmitErrorTransition
 *    - closeDialogTransition: clears dialog
 *    - entityToFormValues: row → form-values projection
 */

import { describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  SOURCE_DROPDOWN_ALL_VALUE,
  TASK_SCHEMA,
  applySearchTransition,
  buildSourceDropdownOptions,
  closeDialogTransition,
  entityToFormValues,
  initialWorkEntityPageState,
  openCreateDialogTransition,
  openEditDialogTransition,
  selectKindTransition,
  selectSourceTransition,
  setDialogErrorsTransition,
  setDialogSourceTransition,
  setDialogSubmitErrorTransition,
  setDialogSubmittingTransition,
  setDialogValuesTransition,
  type WorkEntity,
} from '../index.js';

const NOW = 1_700_000_000_000;

const taskRow = (over: Partial<WorkEntity & { _kind: 'task' }> = {}): WorkEntity =>
  ({
    _kind: 'task',
    id: 'task-1',
    title: 'Buy milk',
    body: undefined,
    done: false,
    due_at: undefined,
    priority: undefined,
    created_at: NOW,
    updated_at: NOW,
    completed_at: undefined,
    assigned_contact_id: 'contact-9',
    parent_calendar_event_id: undefined,
    linked_mail_thread_id: undefined,
    parent_project_id: undefined,
    blocks_task_ids: ['task-99'],
    source_id: 'recued.task',
    last_seen_at: NOW,
    sync_state: 'live',
    conflict_policy: 'manual_merge',
    ...over,
  } as WorkEntity);

describe('D-145 PA6 — initialWorkEntityPageState', () => {
  it('seeds with the kind, null Source, empty search, no dialog', () => {
    expect(initialWorkEntityPageState({ kind: 'task' })).toEqual({
      kind: 'task',
      selected_source_id: null,
      search_query: '',
      dialog: null,
    });
  });

  it('honors explicit overrides', () => {
    const state = initialWorkEntityPageState({
      kind: 'note',
      selected_source_id: 'recued.note',
      search_query: 'foo',
    });
    expect(state.kind).toBe('note');
    expect(state.selected_source_id).toBe('recued.note');
    expect(state.search_query).toBe('foo');
    expect(state.dialog).toBeNull();
  });
});

describe('D-145 PA6 — selectKindTransition', () => {
  it('returns a fresh page-state for the new kind, clearing search + Source + dialog', () => {
    const before = {
      kind: 'task' as const,
      selected_source_id: 'hubspot.acme.task',
      search_query: 'foo',
      dialog: {
        mode: 'create' as const,
        source_id: 'hubspot.acme.task',
        values: {},
        errors: {},
      },
    };
    const after = selectKindTransition(before, 'commitment');
    expect(after.kind).toBe('commitment');
    expect(after.selected_source_id).toBeNull();
    expect(after.search_query).toBe('');
    expect(after.dialog).toBeNull();
  });

  it('returns the same state ref when the kind is unchanged (cheap re-render gate)', () => {
    const before = initialWorkEntityPageState({ kind: 'task' });
    const after = selectKindTransition(before, 'task');
    expect(after).toBe(before);
  });
});

describe('D-145 PA6 — selectSourceTransition', () => {
  it('maps sentinel to null', () => {
    const state = initialWorkEntityPageState({
      kind: 'task',
      selected_source_id: 'recued.task',
    });
    expect(
      selectSourceTransition(state, SOURCE_DROPDOWN_ALL_VALUE).selected_source_id,
    ).toBeNull();
  });

  it('pins concrete dropdown ids verbatim', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    expect(
      selectSourceTransition(state, 'hubspot.acme.task').selected_source_id,
    ).toBe('hubspot.acme.task');
  });

  it('clears the search query on Source change', () => {
    const state = initialWorkEntityPageState({
      kind: 'task',
      selected_source_id: null,
      search_query: 'foo',
    });
    expect(selectSourceTransition(state, 'recued.task').search_query).toBe('');
  });

  it('preserves an open dialog on Source change', () => {
    const state = openCreateDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      'recued.task',
    );
    const after = selectSourceTransition(state, 'hubspot.acme.task');
    expect(after.dialog).not.toBeNull();
    expect(after.dialog?.source_id).toBe('recued.task');
  });

  it('returns same state ref when selection unchanged', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    expect(selectSourceTransition(state, SOURCE_DROPDOWN_ALL_VALUE)).toBe(state);
  });
});

describe('D-145 PA6 — applySearchTransition', () => {
  it('updates search_query verbatim (preserves whitespace)', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    expect(applySearchTransition(state, '  hello  ').search_query).toBe(
      '  hello  ',
    );
  });

  it('returns same state ref on no-op', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    expect(applySearchTransition(state, '')).toBe(state);
  });
});

describe('D-145 PA6 — openCreateDialogTransition', () => {
  it('seeds a create dialog with source_id + initial_values', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    const after = openCreateDialogTransition(state, 'recued.task', {
      title: 'pre-filled',
      done: false,
    });
    expect(after.dialog).toEqual({
      mode: 'create',
      source_id: 'recued.task',
      values: { title: 'pre-filled', done: false },
      errors: {},
    });
  });

  it('defaults to empty values when none supplied', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    expect(
      openCreateDialogTransition(state, 'recued.task').dialog?.values,
    ).toEqual({});
  });
});

describe('D-145 PA6 — openEditDialogTransition', () => {
  it('seeds an edit dialog with entity_id + projected values + row source_id', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    const row = taskRow({ id: 'task-7', title: 'Edit me' });
    const after = openEditDialogTransition(state, row, TASK_SCHEMA);
    expect(after.dialog?.mode).toBe('edit');
    expect(after.dialog?.entity_id).toBe('task-7');
    expect(after.dialog?.source_id).toBe('recued.task');
    expect(after.dialog?.values).toMatchObject({
      id: 'task-7',
      title: 'Edit me',
      done: false,
    });
    expect(after.dialog?.errors).toEqual({});
  });
});

describe('D-145 PA6 — entityToFormValues', () => {
  it('projects canonical fields verbatim', () => {
    const row = taskRow({ title: 'X', done: true, due_at: 12345 });
    const values = entityToFormValues(row, TASK_SCHEMA);
    expect(values.title).toBe('X');
    expect(values.done).toBe(true);
    expect(values.due_at).toBe(12345);
  });

  it('projects relationship cardinality "one" via _id suffix mapping', () => {
    const row = taskRow({ assigned_contact_id: 'contact-9' });
    const values = entityToFormValues(row, TASK_SCHEMA);
    expect(values.assigned_contact).toBe('contact-9');
  });

  it('projects relationship cardinality "many" via _ids suffix mapping', () => {
    const row = taskRow({ blocks_task_ids: ['task-99'] });
    const values = entityToFormValues(row, TASK_SCHEMA);
    expect(values.blocks_task).toEqual(['task-99']);
  });

  it('omits undefined fields entirely so renderer falls back to defaults', () => {
    const row = taskRow({ priority: undefined });
    const values = entityToFormValues(row, TASK_SCHEMA);
    expect('priority' in values).toBe(false);
  });
});

describe('D-145 PA6 — setDialogValuesTransition', () => {
  it('updates values without touching mode / source / id', () => {
    const state = openCreateDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      'recued.task',
    );
    const after = setDialogValuesTransition(state, { title: 'patched' });
    expect(after.dialog?.values).toEqual({ title: 'patched' });
    expect(after.dialog?.mode).toBe('create');
    expect(after.dialog?.source_id).toBe('recued.task');
  });

  it('returns same state ref when no dialog is open', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    expect(setDialogValuesTransition(state, { title: 'x' })).toBe(state);
  });
});

describe('D-145 PA6 — setDialogErrorsTransition', () => {
  it('updates the per-field error map', () => {
    const state = openCreateDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      'recued.task',
    );
    const after = setDialogErrorsTransition(state, { title: 'Required' });
    expect(after.dialog?.errors).toEqual({ title: 'Required' });
  });
});

describe('D-145 PA6 — setDialogSubmittingTransition', () => {
  it('sets submitting flag', () => {
    const state = openCreateDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      'recued.task',
    );
    expect(setDialogSubmittingTransition(state, true).dialog?.submitting).toBe(
      true,
    );
  });

  it('clears submitting flag', () => {
    const state = setDialogSubmittingTransition(
      openCreateDialogTransition(
        initialWorkEntityPageState({ kind: 'task' }),
        'recued.task',
      ),
      true,
    );
    expect(setDialogSubmittingTransition(state, false).dialog?.submitting).toBeUndefined();
  });
});

describe('D-145 PA6 — setDialogSubmitErrorTransition', () => {
  it('attaches a top-level submit error', () => {
    const state = openCreateDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      'recued.task',
    );
    const after = setDialogSubmitErrorTransition(state, 'Storage offline');
    expect(after.dialog?.submit_error).toBe('Storage offline');
  });

  it('clears submit error when null is passed', () => {
    const state = setDialogSubmitErrorTransition(
      openCreateDialogTransition(
        initialWorkEntityPageState({ kind: 'task' }),
        'recued.task',
      ),
      'oops',
    );
    expect(setDialogSubmitErrorTransition(state, null).dialog?.submit_error).toBeUndefined();
  });
});

describe('D-145 PA6 — closeDialogTransition', () => {
  it('clears the dialog', () => {
    const state = openCreateDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      'recued.task',
    );
    expect(closeDialogTransition(state).dialog).toBeNull();
  });

  it('is a no-op when no dialog is open', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    expect(closeDialogTransition(state)).toBe(state);
  });
});

// ────────────────────────────────────────────────────────────────
// Codex P2 fold — setDialogSourceTransition (closes the gap where
// the dialog rendered `data-action="select-create-source"` but no
// transition wrote `dialog.source_id`, so submit dispatched against
// the prior Source).
// ────────────────────────────────────────────────────────────────

describe('D-145 PA6 — setDialogSourceTransition (Codex P2 fold)', () => {
  it('writes the new source_id on a create-mode dialog', () => {
    const state = openCreateDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      'recued.task',
    );
    const after = setDialogSourceTransition(state, 'hubspot.acme.task');
    expect(after.dialog?.source_id).toBe('hubspot.acme.task');
    expect(after.dialog?.mode).toBe('create');
  });

  it('rejects the transition on edit-mode dialog (Sources do not move at PA6)', () => {
    const sample: WorkEntity = {
      _kind: 'task',
      id: 'task-7',
      title: 'X',
      done: false,
      blocks_task_ids: [],
      created_at: 1,
      updated_at: 1,
      source_id: 'recued.task',
      last_seen_at: 1,
      sync_state: 'live',
      conflict_policy: 'manual_merge',
    } as WorkEntity;
    const state = openEditDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      sample,
      TASK_SCHEMA,
    );
    expect(setDialogSourceTransition(state, 'hubspot.acme.task')).toBe(state);
  });

  it('is a no-op when no dialog is open', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    expect(setDialogSourceTransition(state, 'recued.task')).toBe(state);
  });

  it('returns the same state ref when source_id is unchanged', () => {
    const state = openCreateDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      'recued.task',
    );
    expect(setDialogSourceTransition(state, 'recued.task')).toBe(state);
  });
});

// ────────────────────────────────────────────────────────────────
// Codex P2 fold — selectSourceTransition validates against
// known dropdown ids when the optional set is supplied.
// ────────────────────────────────────────────────────────────────

describe('D-145 PA6 — selectSourceTransition optional validation (Codex P2 fold)', () => {
  it('still works without the validation set (backward-compatible)', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    expect(
      selectSourceTransition(state, 'hubspot.acme.task').selected_source_id,
    ).toBe('hubspot.acme.task');
  });

  it('honors the validation set on known ids', () => {
    const opts = buildSourceDropdownOptions('task', [
      {
        id: RECUED_BUILTIN_SOURCE_ID('task'),
        top_tier_kind: 'task',
        source_kind: 'builtin',
        source_label: 'Recued (task)',
        write_capable: true,
        registered_at: 1,
      },
    ]);
    const valid = new Set(opts.map((o) => o.id));
    const state = initialWorkEntityPageState({ kind: 'task' });
    expect(
      selectSourceTransition(state, RECUED_BUILTIN_SOURCE_ID('task'), valid)
        .selected_source_id,
    ).toBe(RECUED_BUILTIN_SOURCE_ID('task'));
  });

  it('rejects unknown ids when the validation set is supplied', () => {
    const valid = new Set([SOURCE_DROPDOWN_ALL_VALUE, 'recued.task']);
    const state = initialWorkEntityPageState({ kind: 'task' });
    expect(selectSourceTransition(state, 'forged.evil.task', valid)).toBe(state);
  });

  it('accepts the All-Sources sentinel via validation set', () => {
    const valid = new Set([SOURCE_DROPDOWN_ALL_VALUE, 'recued.task']);
    const state = initialWorkEntityPageState({
      kind: 'task',
      selected_source_id: 'recued.task',
    });
    expect(
      selectSourceTransition(state, SOURCE_DROPDOWN_ALL_VALUE, valid)
        .selected_source_id,
    ).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Codex P2 fold — discriminated dialog state.
// `mode: 'edit'` MUST carry `entity_id`; `mode: 'create'` MUST NOT.
// ────────────────────────────────────────────────────────────────

describe('D-145 PA6 — discriminated dialog state (Codex P2 fold)', () => {
  it('openCreateDialogTransition emits a create dialog without entity_id', () => {
    const state = openCreateDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      'recued.task',
    );
    expect(state.dialog?.mode).toBe('create');
    if (state.dialog?.mode === 'create') {
      // TS narrowing — entity_id is `undefined` on create branch.
      expect(state.dialog.entity_id).toBeUndefined();
    }
  });

  it('openEditDialogTransition emits an edit dialog with entity_id', () => {
    const sample: WorkEntity = {
      _kind: 'task',
      id: 'task-7',
      title: 'X',
      done: false,
      blocks_task_ids: [],
      created_at: 1,
      updated_at: 1,
      source_id: 'recued.task',
      last_seen_at: 1,
      sync_state: 'live',
      conflict_policy: 'manual_merge',
    } as WorkEntity;
    const state = openEditDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      sample,
      TASK_SCHEMA,
    );
    expect(state.dialog?.mode).toBe('edit');
    if (state.dialog?.mode === 'edit') {
      // TS narrowing — entity_id is `string` (required) on edit branch.
      expect(state.dialog.entity_id).toBe('task-7');
    }
  });

  it('patches preserve the discriminator across transitions', () => {
    const sample: WorkEntity = {
      _kind: 'task',
      id: 'task-9',
      title: 'X',
      done: false,
      blocks_task_ids: [],
      created_at: 1,
      updated_at: 1,
      source_id: 'recued.task',
      last_seen_at: 1,
      sync_state: 'live',
      conflict_policy: 'manual_merge',
    } as WorkEntity;
    let state = openEditDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      sample,
      TASK_SCHEMA,
    );
    state = setDialogValuesTransition(state, { title: 'updated' });
    state = setDialogErrorsTransition(state, { title: 'X' });
    state = setDialogSubmittingTransition(state, true);
    expect(state.dialog?.mode).toBe('edit');
    if (state.dialog?.mode === 'edit') {
      expect(state.dialog.entity_id).toBe('task-9');
      expect(state.dialog.values).toEqual({ title: 'updated' });
      expect(state.dialog.errors).toEqual({ title: 'X' });
      expect(state.dialog.submitting).toBe(true);
    }
  });
});
