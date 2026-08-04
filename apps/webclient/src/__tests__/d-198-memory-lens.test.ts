/** D-198 Slice 1b — Memory lens feed render tests (pure module).
 *
 *  Covers `renderMemoryLens` / `renderLensSwitcher` / `memoryFilterActors`
 *  (`apps/webclient/src/data/memory-lens.ts`): row projection, the origin
 *  filter chips, the size chip + preview, empty/loading/error states, XSS
 *  escaping, and the lens switcher active-state. Route integration (mount,
 *  live refresh, filter → memory.list) is exercised by the browser verify.
 */

import { describe, expect, it } from 'vitest';
import type { MemoryListEntry } from '@recued/contracts';
import {
  MEMORY_ADD_ACTION,
  MEMORY_COMPOSE_CANCEL_ACTION,
  MEMORY_COMPOSE_DISCARD_COMMIT_ACTION,
  MEMORY_COMPOSE_DISCARD_COMMIT_ATTR,
  MEMORY_COMPOSE_DISCARD_GUARD_ATTR,
  MEMORY_COMPOSE_DISCARD_KEEP_ACTION,
  MEMORY_COMPOSE_DISCARD_KEEP_ATTR,
  MEMORY_COMPOSE_SUBMIT_ACTION,
  MEMORY_DELETE_ACTION,
  MEMORY_DELETE_CANCEL_ACTION,
  MEMORY_DELETE_CONFIRM_ACTION,
  MEMORY_DETAIL_HEADING_ATTR,
  MEMORY_EDIT_ACTION,
  MEMORY_EXPORT_ACTION,
  MEMORY_FILTER_ACTION,
  MEMORY_IMPORT_ACTION,
  MEMORY_IMPORT_CANCEL_ACTION,
  MEMORY_IMPORT_DISCARD_COMMIT_ACTION,
  MEMORY_IMPORT_DISCARD_COMMIT_ATTR,
  MEMORY_IMPORT_DISCARD_GUARD_ATTR,
  MEMORY_IMPORT_DISCARD_KEEP_ACTION,
  MEMORY_IMPORT_DISCARD_KEEP_ATTR,
  MEMORY_IMPORT_SUBMIT_ACTION,
  MEMORY_LENS_STYLES,
  MEMORY_LENS_SELECT_ACTION,
  MEMORY_OPEN_ACTION,
  MEMORY_OPEN_RUN_ACTION,
  memoryFilterActors,
  renderLensSwitcher,
  renderMemoryLens,
  type MemoryComposeState,
  type MemoryDetailState,
  type MemoryImportState,
  type MemoryOriginFilter,
} from '../data/memory-lens.js';

const entry = (
  o: Partial<MemoryListEntry> & {
    memory_id: string;
    origin_actor: MemoryListEntry['origin_actor'];
    kind: string;
    ts: number;
  },
): MemoryListEntry => o as MemoryListEntry;

const baseProps = {
  originFilter: 'all' as MemoryOriginFilter,
  loading: false,
  now: 1_000_000,
  actionAttr: 'data-recued-data-action',
  runHref: (id: string) => `#logs/${id}`,
};

describe('memoryFilterActors', () => {
  it('maps `all` → undefined (whole feed) and each origin → its single actor', () => {
    expect(memoryFilterActors('all')).toBeUndefined();
    expect(memoryFilterActors('user_self')).toEqual(['user_self']);
    expect(memoryFilterActors('contracted_user')).toEqual(['contracted_user']);
    expect(memoryFilterActors('system')).toEqual(['system']);
  });
});

describe('renderMemoryLens', () => {
  it('renders a row per entry with origin chip + kind + run link, every origin shown', () => {
    const html = renderMemoryLens({
      ...baseProps,
      entries: [
        entry({ memory_id: 'a', origin_actor: 'user_self', kind: 'note', ts: 999_000, summary: 'a note', run_id: 'r1' }),
        entry({ memory_id: 'b', origin_actor: 'system', kind: 'run', ts: 998_000 }),
      ],
    });
    expect(html).toContain('memory-origin-user_self');
    expect(html).toContain('>You<');
    expect(html).toContain('a note');
    expect(html).toContain('href="#logs/r1"');
    // transparency: the system-authored row is shown too
    expect(html).toContain('>System<');
  });

  it('shows the size chip + body preview when the entry carries a body', () => {
    const html = renderMemoryLens({
      ...baseProps,
      entries: [
        entry({ memory_id: 'c', origin_actor: 'contracted_user', kind: 'fact', ts: 999_000, body_preview: 'remembered fact', size_bytes: 2048 }),
      ],
    });
    expect(html).toContain('remembered fact');
    expect(html).toContain('2 KB');
    expect(html).toContain('>Agent<');
  });

  it('escapes untrusted preview text (XSS guard)', () => {
    const html = renderMemoryLens({
      ...baseProps,
      entries: [
        entry({ memory_id: 'x', origin_actor: 'user_self', kind: 'note', ts: 999_000, summary: '<script>alert(1)</script>' }),
      ],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders empty / loading / error states', () => {
    expect(renderMemoryLens({ ...baseProps, entries: [] })).toContain('No memory entries');
    expect(renderMemoryLens({ ...baseProps, entries: [], loading: true })).toContain('Loading memory');
    expect(renderMemoryLens({ ...baseProps, entries: [], error: 'boom' })).toContain('boom');
  });

  it('marks the active origin-filter chip + emits the filter action', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [], originFilter: 'user_self' });
    expect(html).toMatch(/memory-filter-chip is-active[^>]*data-memory-filter="user_self"/);
    expect(html).toContain(MEMORY_FILTER_ACTION);
  });

  it('owns an origin-filter refresh and locks stale feed actions', () => {
    const html = renderMemoryLens({
      ...baseProps,
      entries: [
        entry({
          memory_id: 'own',
          origin_actor: 'user_self',
          kind: 'note',
          ts: 999_000,
          has_body: true,
        }),
        entry({
          memory_id: 'system',
          origin_actor: 'system',
          kind: 'run',
          ts: 998_000,
          run_id: 'run-1',
        }),
      ],
      originFilter: 'user_self',
      filteringOrigin: 'user_self',
      canWrite: true,
    });
    const activeChip = html.match(
      /<button[^>]*data-memory-filter="user_self"[^>]*>[^<]*<\/button>/,
    )?.[0] ?? '';
    expect(activeChip).toContain('aria-disabled="true"');
    expect(activeChip).toContain('aria-busy="true"');
    expect(activeChip).toContain('You…');
    expect(html.match(/memory-filter-chip[^>]*aria-disabled="true"/g))
      .toHaveLength(4);
    expect(html).toMatch(
      new RegExp(`${MEMORY_EXPORT_ACTION}[^>]*aria-disabled="true"`),
    );
    expect(html).toMatch(
      new RegExp(`${MEMORY_OPEN_ACTION}[^>]*aria-disabled="true"`),
    );
    expect(html).toMatch(
      new RegExp(`${MEMORY_OPEN_RUN_ACTION}[^>]*aria-disabled="true"`),
    );
  });
});

describe('renderLensSwitcher', () => {
  it('marks the active lens + emits the select-lens action for both buttons', () => {
    const html = renderLensSwitcher('memory', 'data-recued-data-action');
    expect(html).toContain(MEMORY_LENS_SELECT_ACTION);
    expect(html).toMatch(/data-lens-btn is-active[^>]*data-memory-lens="memory"/);
    expect(html).toContain('data-memory-lens="data"');
    const locked = renderLensSwitcher(
      'memory',
      'data-recued-data-action',
      true,
    );
    expect(locked.match(/aria-disabled="true"/g)).toHaveLength(2);
  });

  it('uses canonical high-contrast theme tokens for the active lens and row actions', () => {
    expect(MEMORY_LENS_STYLES).toMatch(
      /\.data-lens-btn\.is-active\s*\{[^}]*background:\s*var\(--surface\);[^}]*color:\s*var\(--fg-strong\)/s,
    );
    expect(MEMORY_LENS_STYLES).toMatch(
      /\.memory-row-btn, \.memory-btn\s*\{[^}]*background:\s*var\(--surface\);[^}]*color:\s*var\(--fg-strong\)/s,
    );
    expect(MEMORY_LENS_STYLES).not.toMatch(
      /var\(--(?:text|text-muted|surface-2)\b/,
    );
  });
});

describe('renderMemoryLens — Slice 2 CRUD affordances', () => {
  const own = entry({
    memory_id: 'umem_1', origin_actor: 'user_self', kind: 'note', ts: 999_000,
    has_body: true, body_preview: 'mine', size_bytes: 4,
  });
  const audit = entry({ memory_id: 'run-1', origin_actor: 'system', kind: 'run', ts: 998_000 });

  it('shows "Add memory" only when writes are wired', () => {
    expect(renderMemoryLens({ ...baseProps, entries: [], canWrite: true })).toContain(MEMORY_ADD_ACTION);
    expect(renderMemoryLens({ ...baseProps, entries: [] })).not.toContain(MEMORY_ADD_ACTION);
  });

  it('renders Edit/Delete only on OWN rows, and only when canWrite', () => {
    const rw = renderMemoryLens({ ...baseProps, entries: [own, audit], canWrite: true });
    expect(rw).toMatch(new RegExp(`${MEMORY_EDIT_ACTION}[^>]*data-memory-id="umem_1"`));
    expect(rw).toMatch(new RegExp(`${MEMORY_DELETE_ACTION}[^>]*data-memory-id="umem_1"`));
    // the system/audit row is view-only — never editable/deletable
    expect(rw).not.toMatch(new RegExp(`${MEMORY_EDIT_ACTION}[^>]*data-memory-id="run-1"`));
    // read-only mode hides every write affordance
    expect(renderMemoryLens({ ...baseProps, entries: [own], canWrite: false })).not.toContain(MEMORY_EDIT_ACTION);
  });

  it('renders a "View" affordance only for rows carrying a body', () => {
    expect(renderMemoryLens({ ...baseProps, entries: [own], canWrite: true })).toContain(MEMORY_OPEN_ACTION);
    expect(renderMemoryLens({ ...baseProps, entries: [audit], canWrite: true })).not.toContain(MEMORY_OPEN_ACTION);
  });

  it('renders the inline delete-confirm for the pending row', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [own], canWrite: true, pendingDeleteId: 'umem_1' });
    expect(html).toContain(MEMORY_DELETE_CONFIRM_ACTION);
    expect(html).toContain('Delete this memory?');
  });

  it('keeps a pending Delete/Forget action focusable and marks Cancel inert', () => {
    const ownHtml = renderMemoryLens({
      ...baseProps,
      entries: [own],
      canWrite: true,
      pendingDeleteId: 'umem_1',
      deletingId: 'umem_1',
    });
    const confirm = ownHtml.match(
      new RegExp(`<button[^>]*${MEMORY_DELETE_CONFIRM_ACTION}[^>]*>`),
    )?.[0] ?? '';
    const cancel = ownHtml.match(
      new RegExp(`<button[^>]*${MEMORY_DELETE_CANCEL_ACTION}[^>]*>`),
    )?.[0] ?? '';

    expect(ownHtml).toContain('Deleting…');
    expect(confirm).toContain('aria-disabled="true"');
    expect(confirm).toContain('aria-busy="true"');
    expect(confirm).not.toMatch(/\sdisabled(?:\s|=|>)/);
    expect(cancel).toContain('aria-disabled="true"');
    expect(cancel).not.toMatch(/\sdisabled(?:\s|=|>)/);

    const otherHtml = renderMemoryLens({
      ...baseProps,
      entries: [audit],
      canWrite: true,
      pendingDeleteId: 'run-1',
      deletingId: 'run-1',
    });
    expect(otherHtml).toContain('Forgetting…');

    const retryHtml = renderMemoryLens({
      ...baseProps,
      entries: [own],
      canWrite: true,
      pendingDeleteId: 'umem_1',
      deleteError: '<retry safely>',
    });
    expect(retryHtml).toContain('role="alert"');
    expect(retryHtml).toContain('&lt;retry safely&gt;');
    expect(retryHtml).not.toContain('<retry safely>');
  });

  it('keeps the Edit prefill owner focusable and its failure local to the row', () => {
    const openingHtml = renderMemoryLens({
      ...baseProps,
      entries: [own],
      canWrite: true,
      openingEditId: 'umem_1',
    });
    const edit = openingHtml.match(
      new RegExp(`<button[^>]*${MEMORY_EDIT_ACTION}[^>]*>`),
    )?.[0] ?? '';
    const remove = openingHtml.match(
      new RegExp(`<button[^>]*${MEMORY_DELETE_ACTION}[^>]*>`),
    )?.[0] ?? '';

    expect(openingHtml).toContain('Opening…');
    expect(edit).toContain('aria-disabled="true"');
    expect(edit).toContain('aria-busy="true"');
    expect(edit).not.toMatch(/\sdisabled(?:\s|=|>)/);
    expect(remove).toContain('aria-disabled="true"');

    const failedHtml = renderMemoryLens({
      ...baseProps,
      entries: [own],
      canWrite: true,
      editError: { memoryId: 'umem_1', message: '<try edit again>' },
    });
    expect(failedHtml).toContain('role="alert"');
    expect(failedHtml).toContain('&lt;try edit again&gt;');
    expect(failedHtml).not.toContain('<try edit again>');
    expect(failedHtml).toContain('>Edit</button>');
  });

  it('renders the compose form over the list (view stack: compose > list)', () => {
    const compose: MemoryComposeState = { open: true, mode: 'create', kind: 'note', summary: '', body: 'hi', submitting: false };
    const html = renderMemoryLens({ ...baseProps, entries: [own], canWrite: true, compose });
    expect(html).toContain('New memory');
    expect(html).toContain(MEMORY_COMPOSE_SUBMIT_ACTION);
    expect(html).toContain('data-memory-field="kind"');
    expect(html).not.toContain('memory-list'); // the list is replaced by the form
  });

  it('prefills the compose form in edit mode', () => {
    const compose: MemoryComposeState = { open: true, mode: 'edit', editId: 'umem_1', kind: 'note', summary: 's', body: 'B', submitting: false };
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, compose });
    expect(html).toContain('Edit memory');
    expect(html).toContain('value="note"');
    expect(html).toContain('>B</textarea>');
  });

  it('reviews a draft discard in an alertdialog while the editor is inert', () => {
    const compose: MemoryComposeState = {
      open: true,
      mode: 'create',
      kind: 'preference',
      summary: '',
      body: 'Keep answers concise',
      submitting: false,
    };
    const html = renderMemoryLens({
      ...baseProps,
      entries: [],
      canWrite: true,
      compose,
      composeDiscardGuard: true,
    });

    expect(html).toContain(MEMORY_COMPOSE_DISCARD_GUARD_ATTR);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain(MEMORY_COMPOSE_DISCARD_KEEP_ACTION);
    expect(html).toContain(MEMORY_COMPOSE_DISCARD_KEEP_ATTR);
    expect(html).toContain(MEMORY_COMPOSE_DISCARD_COMMIT_ACTION);
    expect(html).toContain(MEMORY_COMPOSE_DISCARD_COMMIT_ATTR);
    expect(html).toContain('class="memory-compose-editor" inert aria-hidden="true"');
    expect(html).toContain('Keep answers concise');
  });

  it('keeps the saving action focusable while making compose controls inert', () => {
    const compose: MemoryComposeState = {
      open: true,
      mode: 'create',
      kind: 'preference',
      summary: '',
      body: 'Keep answers concise',
      submitting: true,
    };
    const html = renderMemoryLens({
      ...baseProps,
      entries: [],
      canWrite: true,
      compose,
    });
    const save = html.match(
      new RegExp(`<button[^>]*${MEMORY_COMPOSE_SUBMIT_ACTION}[^>]*>`),
    )?.[0] ?? '';
    const cancel = html.match(
      new RegExp(`<button[^>]*${MEMORY_COMPOSE_CANCEL_ACTION}[^>]*>`),
    )?.[0] ?? '';

    expect(html).toContain('data-memory-field="kind" readonly');
    expect(html).toContain('data-memory-field="summary" readonly');
    expect(html).toContain('data-memory-field="body" readonly');
    expect(save).toContain('aria-disabled="true"');
    expect(save).toContain('aria-busy="true"');
    expect(save).not.toMatch(/\sdisabled(?:\s|=|>)/);
    expect(cancel).toContain('aria-disabled="true"');
    expect(cancel).not.toMatch(/\sdisabled(?:\s|=|>)/);
  });

  it('renders the detail view with the full body, winning the view stack', () => {
    const detail: MemoryDetailState = {
      memory_id: 'umem_1', loading: false,
      entry: { memory_id: 'umem_1', origin_actor: 'user_self', kind: 'note', ts: 999_000, summary: 'sum', body: 'the full body text', size_bytes: 18 },
    };
    const html = renderMemoryLens({ ...baseProps, entries: [own], canWrite: true, detail });
    expect(html).toContain('the full body text');
    expect(html).toContain(MEMORY_DETAIL_HEADING_ATTR);
    expect(html).toContain('tabindex="-1">Memory detail</h2>');
    expect(html).toContain(MEMORY_EDIT_ACTION); // own → editable from detail
    // detail beats an open compose form
    const compose: MemoryComposeState = { open: true, mode: 'create', kind: '', summary: '', body: '', submitting: false };
    expect(renderMemoryLens({ ...baseProps, entries: [], canWrite: true, compose, detail })).toContain('the full body text');
  });

  it('escapes the detail body (XSS guard)', () => {
    const detail: MemoryDetailState = {
      memory_id: 'umem_1', loading: false,
      entry: { memory_id: 'umem_1', origin_actor: 'user_self', kind: 'note', ts: 1, body: '<img src=x onerror=alert(1)>', size_bytes: 1 },
    };
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, detail });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('renders detail loading + error states', () => {
    expect(renderMemoryLens({ ...baseProps, entries: [], detail: { memory_id: 'umem_1', loading: true } })).toContain('Loading memory');
    expect(renderMemoryLens({ ...baseProps, entries: [], detail: { memory_id: 'umem_1', loading: false, error: 'nope' } })).toContain('nope');
  });
});

describe('renderMemoryLens — Slice 3 import panel', () => {
  it('shows the Import affordance only when writes are wired', () => {
    expect(renderMemoryLens({ ...baseProps, entries: [], canWrite: true })).toContain(MEMORY_IMPORT_ACTION);
    expect(renderMemoryLens({ ...baseProps, entries: [] })).not.toContain(MEMORY_IMPORT_ACTION);
  });

  it('renders the import panel over the list with a JSON textarea', () => {
    const importPanel: MemoryImportState = { open: true, text: '{"entries":[]}', submitting: false };
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, importPanel });
    expect(html).toContain('Import memory');
    expect(html).toContain('data-memory-field="import"');
    expect(html).toContain(MEMORY_IMPORT_SUBMIT_ACTION);
    expect(html).not.toContain('memory-list'); // the list is replaced by the panel
  });

  it('shows the import tally on success', () => {
    const importPanel: MemoryImportState = {
      open: true, text: '', submitting: false,
      result: { merged: 1, inserted: 2, deduped: 3, skipped: 0 },
    };
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, importPanel });
    expect(html).toMatch(/merged 1/);
    expect(html).toMatch(/inserted 2/);
    expect(html).toMatch(/deduped 3/);
  });

  it('reviews a populated import draft while the JSON editor is inert', () => {
    const importPanel: MemoryImportState = {
      open: true,
      text: '{"entries":[{"kind":"note"}]}',
      submitting: false,
    };
    const html = renderMemoryLens({
      ...baseProps,
      entries: [],
      canWrite: true,
      importPanel,
      importDiscardGuard: true,
    });

    expect(html).toContain(MEMORY_IMPORT_DISCARD_GUARD_ATTR);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain(MEMORY_IMPORT_DISCARD_KEEP_ACTION);
    expect(html).toContain(MEMORY_IMPORT_DISCARD_KEEP_ATTR);
    expect(html).toContain(MEMORY_IMPORT_DISCARD_COMMIT_ACTION);
    expect(html).toContain(MEMORY_IMPORT_DISCARD_COMMIT_ATTR);
    expect(html).toContain('class="memory-import-editor" inert aria-hidden="true"');
    expect(html).toContain('&quot;kind&quot;:&quot;note&quot;');
  });

  it('keeps the importing action focusable while making import controls inert', () => {
    const importPanel: MemoryImportState = {
      open: true,
      text: '{"entries":[]}',
      submitting: true,
    };
    const html = renderMemoryLens({
      ...baseProps,
      entries: [],
      canWrite: true,
      importPanel,
    });
    const submit = html.match(
      new RegExp(`<button[^>]*${MEMORY_IMPORT_SUBMIT_ACTION}[^>]*>`),
    )?.[0] ?? '';
    const close = html.match(
      new RegExp(`<button[^>]*${MEMORY_IMPORT_CANCEL_ACTION}[^>]*>`),
    )?.[0] ?? '';

    expect(html).toContain('data-memory-field="import"');
    expect(html).toMatch(/data-memory-field="import"[^>]*readonly/);
    expect(submit).toContain('aria-disabled="true"');
    expect(submit).toContain('aria-busy="true"');
    expect(submit).not.toMatch(/\sdisabled(?:\s|=|>)/);
    expect(close).toContain('aria-disabled="true"');
    expect(close).not.toMatch(/\sdisabled(?:\s|=|>)/);
  });

  it('surfaces an import error + escapes pasted text (XSS guard)', () => {
    const importPanel: MemoryImportState = {
      open: true, submitting: false,
      text: '</textarea><script>alert(1)</script>',
      error: 'Could not parse JSON',
    };
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, importPanel });
    expect(html).toContain('Could not parse JSON');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderMemoryLens — Slice 3 export', () => {
  it('shows the Export affordance only when writes are wired', () => {
    expect(renderMemoryLens({ ...baseProps, entries: [], canWrite: true })).toContain(MEMORY_EXPORT_ACTION);
    expect(renderMemoryLens({ ...baseProps, entries: [] })).not.toContain(MEMORY_EXPORT_ACTION);
  });

  it('keeps Export focusable and marks competing toolbar controls inert', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, exporting: true });
    const exportButton = html.match(
      new RegExp(`<button[^>]*${MEMORY_EXPORT_ACTION}[^>]*>`),
    )?.[0] ?? '';
    const importButton = html.match(
      new RegExp(`<button[^>]*${MEMORY_IMPORT_ACTION}[^>]*>`),
    )?.[0] ?? '';
    const addButton = html.match(
      new RegExp(`<button[^>]*${MEMORY_ADD_ACTION}[^>]*>`),
    )?.[0] ?? '';
    expect(html).toContain('Exporting…');
    expect(exportButton).toContain('aria-disabled="true"');
    expect(exportButton).toContain('aria-busy="true"');
    expect(exportButton).not.toMatch(/\sdisabled(?:\s|=|>)/);
    expect(importButton).toContain('aria-disabled="true"');
    expect(addButton).toContain('aria-disabled="true"');
    expect(html.match(/memory-filter-chip[^>]*aria-disabled="true"/g))
      .toHaveLength(4);
  });

  it('announces an export failure while keeping the list toolbar available', () => {
    const html = renderMemoryLens({
      ...baseProps,
      entries: [],
      canWrite: true,
      error: 'Memory export temporarily unavailable.',
    });
    expect(html).toContain(
      '<p class="memory-lens-error" role="alert">Memory export temporarily unavailable.</p>',
    );
    expect(html).toContain(MEMORY_EXPORT_ACTION);
  });
});

describe('renderMemoryLens — Slice 4 redaction UI', () => {
  const audit = entry({
    memory_id: 'run-1', origin_actor: 'system', kind: 'run', ts: 998_000,
    summary: 'ran a recipe', run_id: 'run-1',
  });

  it('shows Forget (not Edit) on a non-own row when writes are wired', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [audit], canWrite: true });
    expect(html).toContain('>Forget<');
    expect(html).toMatch(new RegExp(`${MEMORY_DELETE_ACTION}[^>]*data-memory-id="run-1"`));
    expect(html).not.toContain(MEMORY_EDIT_ACTION); // others' rows aren't editable (§3)
  });

  it('renders a redacted row content-cleared + flagged, with no actions', () => {
    const redacted = entry({
      memory_id: 'run-9', origin_actor: 'contracted_user', kind: 'run', ts: 997_000,
      redacted: true,
    });
    const html = renderMemoryLens({ ...baseProps, entries: [redacted], canWrite: true });
    expect(html).toContain('Redacted');
    expect(html).toContain('is-redacted');
    expect(html).not.toContain('memory-delete'); // no Forget/Delete on an already-redacted row
  });

  it('detail: Forget on a non-own row; a redacted-state message on a redacted one', () => {
    const forgettable: MemoryDetailState = {
      memory_id: 'run-1', loading: false,
      entry: { memory_id: 'run-1', origin_actor: 'system', kind: 'run', ts: 1, summary: 'ran', run_id: 'run-1' },
    };
    expect(renderMemoryLens({ ...baseProps, entries: [], canWrite: true, detail: forgettable })).toContain('>Forget<');
    const redacted: MemoryDetailState = {
      memory_id: 'run-2', loading: false,
      entry: { memory_id: 'run-2', origin_actor: 'system', kind: 'run', ts: 1, redacted: true },
    };
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, detail: redacted });
    expect(html).toContain('has been redacted');
    expect(html).not.toContain('>Forget<');
  });
});
