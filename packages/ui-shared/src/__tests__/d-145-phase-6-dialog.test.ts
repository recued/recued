/** D-145 PA6 — create / edit dialog rendering.
 *
 *  Pin per § Phase PA6 (Create-new flow uses form renderer / Per-item
 *  edit flow):
 *    - Create dialog renders title "New <Singular>" + Source picker +
 *      form-renderer body + Save / Cancel buttons.
 *    - Single write-capable Source: source rendered as static value
 *      (not a dropdown).
 *    - Multiple write-capable Sources: source rendered as <select>.
 *    - No write-capable Sources: dialog surfaces a guidance banner.
 *    - Edit dialog renders title "Edit <Singular>" + Source label
 *      (read-only) + form-renderer body.
 *    - Submit-error banner renders when submit_error is set.
 *    - Submit button disables when submitting flag is set.
 *    - data-action wires for close / submit / select-create-source.
 */

import { describe, expect, it } from 'vitest';

import {
  TASK_SCHEMA,
  buildSourceDropdownOptions,
  formFromCanonicalSchema,
  type SourceDropdownOption,
  type WorkEntityPageDialogState,
  type WorkEntityPageDialogStateCreate,
  type WorkEntityPageDialogStateEdit,
} from '@recued/contracts';

import { renderWorkEntityDialog } from '../work-entity-page/dialog.js';

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

const hubspotTask = (over = {}) => ({
  id: 'hubspot.acme.task',
  top_tier_kind: 'task' as const,
  source_kind: 'connection' as const,
  source_label: 'HubSpot tasks (acme)',
  write_capable: true,
  mcp_exposed: false,
  registered_at: NOW + 1,
  ...over,
});

const baseCreateDialog = (
  over: Partial<WorkEntityPageDialogStateCreate> = {},
): WorkEntityPageDialogStateCreate => ({
  mode: 'create',
  source_id: 'recued.task',
  values: {},
  errors: {},
  ...over,
});

const baseEditDialog = (
  over: Partial<WorkEntityPageDialogStateEdit> = {},
): WorkEntityPageDialogStateEdit => ({
  mode: 'edit',
  entity_id: 'task-7',
  source_id: 'recued.task',
  values: { title: 'Existing task' },
  errors: {},
  ...over,
});

describe('D-145 PA6 — create dialog', () => {
  it('renders title "New Task" for kind=task', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog(),
      sources: buildSourceDropdownOptions('task', [builtinTask()]),
    });
    expect(html).toContain('>New Task<');
  });

  it('renders Source as static value when only one write-capable Source exists', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog(),
      sources: buildSourceDropdownOptions('task', [builtinTask()]),
    });
    expect(html).toContain('work-entity-dialog-source-static');
    expect(html).not.toContain('data-action="select-create-source"');
    expect(html).toContain('Recued built-in (task)');
  });

  it('renders Source as <select> with multiple write-capable Sources', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog(),
      sources: buildSourceDropdownOptions('task', [builtinTask(), hubspotTask()]),
    });
    expect(html).toContain('data-action="select-create-source"');
    // Both Source options should be present in the dropdown.
    expect(html).toContain('value="recued.task"');
    expect(html).toContain('value="hubspot.acme.task"');
  });

  it('renders the form-renderer body with passed values + errors', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog({
        values: { title: 'pre' },
        errors: { title: 'Required' },
      }),
      sources: buildSourceDropdownOptions('task', [builtinTask()]),
    });
    expect(html).toContain('class="form-renderer-form"');
    expect(html).toContain('value="pre"');
    expect(html).toContain('Required');
  });

  it('renders Save + Cancel buttons with correct data-actions', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog(),
      sources: buildSourceDropdownOptions('task', [builtinTask()]),
    });
    expect(html).toContain('data-action="submit-work-entity-dialog"');
    expect(html).toContain('data-action="close-work-entity-dialog"');
  });

  it('renders guidance banner when no write-capable Sources exist', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog(),
      sources: buildSourceDropdownOptions('task', [
        hubspotTask({ write_capable: false }),
      ]),
    });
    expect(html).toContain('No write-capable Source for task');
  });
});

describe('D-145 PA6 — edit dialog', () => {
  it('renders title "Edit Task"', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseEditDialog(),
      sources: buildSourceDropdownOptions('task', [builtinTask()]),
    });
    expect(html).toContain('>Edit Task<');
  });

  it('renders Source as static label (no dropdown) regardless of Source count', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseEditDialog(),
      sources: buildSourceDropdownOptions('task', [builtinTask(), hubspotTask()]),
    });
    expect(html).toContain('work-entity-dialog-source-static');
    expect(html).not.toContain('data-action="select-create-source"');
    expect(html).toContain('Recued built-in (task)');
  });
});

describe('D-145 PA6 — submit feedback', () => {
  it('renders submit-error banner when submit_error is set', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog({ submit_error: 'Storage offline' }),
      sources: buildSourceDropdownOptions('task', [builtinTask()]),
    });
    expect(html).toContain('work-entity-dialog-submit-error');
    expect(html).toContain('Storage offline');
  });

  it('disables the submit button + relabels to Saving… when submitting', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog({ submitting: true }),
      sources: buildSourceDropdownOptions('task', [builtinTask()]),
    });
    expect(html).toMatch(
      /data-action="submit-work-entity-dialog"[\s\S]*?\sdisabled[\s>]/,
    );
    expect(html).toContain('Saving…');
  });
});

// ────────────────────────────────────────────────────────────────
// Codex P1 fold — backdrop click bubbles. The substrate-side dialog
// renders a backdrop `data-action` distinct from the close button so
// host event handlers can target-equality-check before closing.
// ────────────────────────────────────────────────────────────────

describe('D-145 PA6 — backdrop click-through (Codex P1 fold)', () => {
  it('backdrop carries close-on-backdrop action (distinct from close-work-entity-dialog)', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog(),
      sources: buildSourceDropdownOptions('task', [builtinTask()]),
    });
    expect(html).toMatch(
      /class="work-entity-dialog-backdrop"[\s\S]*?data-action="close-work-entity-dialog-on-backdrop"/,
    );
  });

  it('close X button + Cancel button still carry close-work-entity-dialog (unconditional close)', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog(),
      sources: buildSourceDropdownOptions('task', [builtinTask()]),
    });
    // Close X
    expect(html).toMatch(
      /class="work-entity-dialog-close"[\s\S]*?data-action="close-work-entity-dialog"/,
    );
    // Cancel
    expect(html).toMatch(
      /class="work-entity-dialog-cancel"[\s\S]*?data-action="close-work-entity-dialog"/,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Codex P2 fold — submit must be disabled when create mode has no
// writable Source (defense-in-depth — page-level gate normally
// suppresses dialog mount in this state).
// ────────────────────────────────────────────────────────────────

describe('D-145 PA6 — submit gate when no writable Source (Codex P2 fold)', () => {
  it('disables submit + surfaces guidance banner when zero write-capable Sources', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog(),
      sources: buildSourceDropdownOptions('task', [
        hubspotTask({ write_capable: false }),
      ]),
    });
    expect(html).toContain('No write-capable Source for task');
    expect(html).toMatch(
      /data-action="submit-work-entity-dialog"[\s\S]*?\sdisabled[\s>]/,
    );
  });

  it('keeps submit enabled when at least one write-capable Source exists', () => {
    const html = renderWorkEntityDialog({
      kind: 'task',
      definition: formFromCanonicalSchema(TASK_SCHEMA),
      state: baseCreateDialog(),
      sources: buildSourceDropdownOptions('task', [builtinTask()]),
    });
    expect(html).not.toMatch(
      /data-action="submit-work-entity-dialog"[\s\S]*?\sdisabled[\s>]/,
    );
  });
});
