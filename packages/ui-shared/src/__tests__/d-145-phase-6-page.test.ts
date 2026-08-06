/** D-145 PA6 — composite work-entity page rendering.
 *
 *  Pin per § Phase PA6 (composition: nav + Source dropdown + list +
 *  create/edit dialog):
 *    - Page renders nav + dropdown + create button + list view.
 *    - Active kind reflected in nav + page heading.
 *    - All Sources mode passes show_source_label: true to list view.
 *    - Concrete Source mode passes show_source_label: false.
 *    - Create button gated on can_create.
 *    - Dialog renders only when state.dialog !== null.
 */

import { describe, expect, it } from 'vitest';

import {
  TASK_SCHEMA,
  buildSourceDropdownOptions,
  formFromCanonicalSchema,
  initialWorkEntityPageState,
  openCreateDialogTransition,
  selectSourceTransition,
  type SourceDropdownOption,
  type WorkEntity,
  type WorkEntityListRow,
  type WorkEntityPageState,
} from '@recued/contracts';

import { renderWorkEntityPage } from '../work-entity-page/page.js';
import { WORK_ENTITY_PAGE_STYLES } from '../work-entity-page/styles.js';

const NOW = 1_700_000_000_000;

const builtinTask = () => ({
  id: 'recued.task',
  top_tier_kind: 'task' as const,
  source_kind: 'builtin' as const,
  source_label: 'Recued built-in (task)',
  write_capable: true,
  mcp_exposed: true,
  registered_at: NOW,
});

const sourceOpt = (over: Partial<SourceDropdownOption> = {}): SourceDropdownOption => ({
  id: 'recued.task',
  label: 'Recued built-in (task)',
  source_kind: 'builtin',
  write_capable: true,
  mcp_exposed: true,
  ...over,
});

const taskRow = (over: Partial<WorkEntity & { _kind: 'task' }> = {}): WorkEntity =>
  ({
    _kind: 'task',
    id: over.id ?? 'task-1',
    title: 'Buy milk',
    body: undefined,
    done: false,
    due_at: undefined,
    priority: undefined,
    created_at: NOW,
    updated_at: NOW,
    completed_at: undefined,
    assigned_contact_id: undefined,
    parent_calendar_event_id: undefined,
    linked_mail_thread_id: undefined,
    parent_project_id: undefined,
    blocks_task_ids: [],
    source_id: 'recued.task',
    last_seen_at: NOW,
    sync_state: 'live',
    conflict_policy: 'manual_merge',
    ...over,
  } as WorkEntity);

const row = (over: Partial<WorkEntity & { _kind: 'task' }> = {}): WorkEntityListRow => ({
  entity: taskRow(over),
  source: sourceOpt(),
});

const baseProps = (state: WorkEntityPageState) => ({
  state,
  source_options: buildSourceDropdownOptions('task', [builtinTask()]),
  rows: [row()] as readonly WorkEntityListRow[],
  form_definition: formFromCanonicalSchema(TASK_SCHEMA),
  can_create: true,
});

describe('D-145 PA6 — renderWorkEntityPage', () => {
  it('composes dropdown + page heading + list view + create button (R18 — no nav)', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    const html = renderWorkEntityPage(baseProps(state));
    // R18 — the redundant per-kind nav was dropped; the Data route's grouped
    // tabs are the single kind nav.
    expect(html).not.toContain('work-entity-nav');
    expect(html).toContain('class="work-entity-source-dropdown"');
    expect(html).toContain(
      '<section class="work-entity-page" data-kind="task"\n'
        + '             aria-labelledby="work-entity-page-task-heading">',
    );
    expect(html).toContain(
      '<h2 class="work-entity-page-title" id="work-entity-page-task-heading">Tasks</h2>',
    );
    expect(html).not.toContain('<h1 class="work-entity-page-title">');
    expect(html).not.toContain('<main class="work-entity-page-body">');
    expect(html).toContain('class="work-entity-list-view"');
    expect(html).toContain('class="work-entity-page-create"');
    expect(html).toContain('>+ New Task<');
  });

  it('keeps the primary create action at the shared control floor', () => {
    expect(WORK_ENTITY_PAGE_STYLES).toContain(
      '.work-entity-page-create {\n  margin-left: auto;\n  min-height: 36px;',
    );
  });

  it('All-Sources mode (selected_source_id null) propagates show_source_label: true', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    const html = renderWorkEntityPage(baseProps(state));
    expect(html).toContain('class="work-entity-list-row-source"');
  });

  it('concrete Source mode hides per-row Source label', () => {
    const state = selectSourceTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      'recued.task',
    );
    const html = renderWorkEntityPage(baseProps(state));
    expect(html).not.toContain('class="work-entity-list-row-source"');
  });

  it('hides create button + surfaces guidance when can_create is false', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    const html = renderWorkEntityPage({
      ...baseProps(state),
      can_create: false,
    });
    expect(html).not.toContain('class="work-entity-page-create"');
    expect(html).toContain('class="work-entity-page-create-disabled"');
  });

  it('renders the dialog when state.dialog !== null', () => {
    const state = openCreateDialogTransition(
      initialWorkEntityPageState({ kind: 'task' }),
      'recued.task',
    );
    const html = renderWorkEntityPage(baseProps(state));
    expect(html).toContain('class="work-entity-dialog-backdrop"');
    expect(html).toContain('role="dialog"');
  });

  it('does not render the dialog when state.dialog is null', () => {
    const state = initialWorkEntityPageState({ kind: 'task' });
    const html = renderWorkEntityPage(baseProps(state));
    expect(html).not.toContain('class="work-entity-dialog-backdrop"');
  });
});
