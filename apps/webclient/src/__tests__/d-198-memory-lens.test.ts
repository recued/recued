/** D-198 Slice 1b — Memory lens feed render tests (pure module).
 *
 *  Covers `renderMemoryLens` / `renderLensSwitcher` / `memoryFilterActors`
 *  (`apps/webclient/src/data/memory-lens.ts`): row projection, the origin
 *  filter chips, the size chip + preview, empty/loading/error states, XSS
 *  escaping, and the lens switcher active-state. Route integration (mount,
 *  live refresh, filter → memory.list) is exercised by the browser verify.
 */

import { describe, expect, it } from 'vitest';
import { qualifyWorkEntityId, type MemoryListEntry } from '@recued/contracts';
import {
  MEMORY_ADD_ACTION,
  MEMORY_BODY_PLACEHOLDER,
  MEMORY_KEYWORDS_HINT,
  MEMORY_MORE_ACTION,
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
  MEMORY_REPLACE_ACTION,
  MEMORY_RESTORE_ACTION,
  MEMORY_REVOKE_ACTION,
  MEMORY_UNREVOKE_ACTION,
  memoryFilterActors,
  MEMORY_CLAIM_ADD_CONTACT_ACTION,
  MEMORY_CLAIM_ADD_THING_ACTION,
  MEMORY_CLAIM_MATCHES_ATTR,
  dropMemoryClaimMatches,
  MEMORY_CLAIM_OFFER_ATTR,
  MEMORY_CLAIM_TAKES_ATTR,
  MEMORY_CLAIM_TAKES_STYLES,
  renderLensSwitcher,
  renderMemoryLens,
  renderClaimCounts,
  MEMORY_CLAIM_COUNTS_ATTR,
  showMemoryClaimTakes,
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
    expect(html).toContain(
      'data-recued-memory-lens\n    aria-labelledby="recued-memory-lens-heading"',
    );
    expect(html).toContain(
      '<h2 class="memory-lens-title" id="recued-memory-lens-heading">Memory</h2>',
    );
    expect(html).toContain('>You<');
    expect(html).toContain('a note');
    expect(html).toContain('href="#logs/r1"');
    expect(html).toContain('data-recued-reference="link"');
    expect(html).toContain('data-recued-reference-id="r1"');
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

  it('shows canonical attribution beside an outside-authored memory in list and detail', () => {
    const outside = entry({
      memory_id: 'run-agent',
      origin_actor: 'contracted_user',
      kind: 'fact',
      ts: 999_000,
      summary: 'A delegated assertion',
      attribution: {
        kind: 'agent',
        origin_actor: 'contracted_user',
        contract_id: 'contract-1',
        label: 'an agent, under contract contract-1, asserted this',
      },
    });
    const list = renderMemoryLens({ ...baseProps, entries: [outside] });
    expect(list).toContain('data-recued-provenance');
    expect(list).toContain('an agent, under contract contract-1, asserted this');

    const detail = renderMemoryLens({
      ...baseProps,
      entries: [],
      detail: { memory_id: outside.memory_id, loading: false, entry: outside },
    });
    expect(detail).toContain('an agent, under contract contract-1, asserted this');
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
    expect(html).toContain('role="group"');
    expect(html).not.toContain('role="tablist"');
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
      /\.data-lens-btn\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(MEMORY_LENS_STYLES).toMatch(
      /\.memory-filter-chip\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(MEMORY_LENS_STYLES).toMatch(
      /\.memory-row-run-link\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(MEMORY_LENS_STYLES).toMatch(
      /\.memory-row-btn, \.memory-btn\s*\{[^}]*min-height:\s*36px/s,
    );
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

  it('contains narrow controls and arbitrary memory text at their owning surface', () => {
    expect(MEMORY_LENS_STYLES).toMatch(
      /\.memory-lens-controls\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0/s,
    );
    expect(MEMORY_LENS_STYLES).toMatch(
      /\.memory-row-kind\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(MEMORY_LENS_STYLES).toMatch(
      /\.memory-row-title\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(MEMORY_LENS_STYLES).toMatch(
      /\.memory-input, \.memory-textarea\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0/s,
    );
    expect(MEMORY_LENS_STYLES).toMatch(
      /\.memory-detail-body\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(MEMORY_LENS_STYLES).toMatch(
      /@media \(max-width:\s*520px\)[\s\S]*\.memory-lens-controls\s*\{[^}]*flex-direction:\s*column/s,
    );
  });
});

describe('renderMemoryLens — Slice 2 CRUD affordances', () => {
  const own = entry({
    memory_id: 'umem_1', origin_actor: 'user_self', kind: 'note', ts: 999_000,
    has_body: true, body_preview: 'mine', size_bytes: 4,
  });
  const audit = entry({ memory_id: 'run-1', origin_actor: 'system', kind: 'run', ts: 998_000, run_id: 'run-1' });

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

  it('gives repeated row actions a visible identity and stable id', () => {
    const secondOwn = entry({
      memory_id: 'umem_2',
      origin_actor: 'user_self',
      kind: 'note',
      ts: 998_000,
      summary: 'Another preference',
      has_body: true,
    });
    const system = entry({
      memory_id: 'run-2',
      origin_actor: 'system',
      kind: 'run',
      ts: 997_000,
      summary: 'Recipe execution remembered',
      run_id: 'recipe-run-2',
    });
    const html = renderMemoryLens({
      ...baseProps,
      entries: [own, secondOwn, system],
      canWrite: true,
    });
    expect(html).toContain('aria-label="View memory mine (umem_1)"');
    expect(html).toContain('aria-label="Edit memory mine (umem_1)"');
    expect(html).toContain('aria-label="Delete memory mine (umem_1)"');
    expect(html).toContain(
      'aria-label="View memory Another preference (umem_2)"',
    );
    expect(html).toContain(
      'aria-label="Open run for memory Recipe execution remembered (run-2)"',
    );
    expect(html).toContain(
      'aria-label="Hide run from AI Recipe execution remembered (run-2)"',
    );
  });

  it('renders a "View" affordance only for rows carrying a body', () => {
    // Quoted: the run row's "Open run" action (`memory-open-run`) contains the bare
    // `memory-open` string, so only the exact attribute value says "no View".
    expect(renderMemoryLens({ ...baseProps, entries: [own], canWrite: true })).toContain(`"${MEMORY_OPEN_ACTION}"`);
    expect(renderMemoryLens({ ...baseProps, entries: [audit], canWrite: true })).not.toContain(`"${MEMORY_OPEN_ACTION}"`);
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
    expect(otherHtml).toContain('Hiding…');

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

  /* The keywords convention is taught HERE or nowhere.
   *
   * There is no `keywords` field and none is needed: recall indexes summary +
   * body as one document, so a `keywords:` line in the body already matches
   * exactly like any other text — measured, an entry carrying
   * `keywords: 2FA, MFA, OTP` answers "2FA" at the EXACT rung while the same
   * entry without it is missed entirely. What was missing was never a schema,
   * it was telling the owner the convention exists. Delete the placeholder and
   * the capability silently stops being used. */
  it('teaches the keywords convention in the compose form', () => {
    const compose: MemoryComposeState = {
      open: true, mode: 'create', kind: 'note', summary: '', body: '', submitting: false,
    };
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, compose });

    expect(html).toContain(MEMORY_BODY_PLACEHOLDER);
    // ⚠ The hint is compared by its distinctive parts, not whole: it contains
    // double quotes, which the renderer escapes to `&quot;`, so the raw
    // constant is correctly ABSENT from the markup. Hard-coding the escaped
    // form would pin the escaper's output rather than the copy. The browser
    // verify reads it back as textContent, where it round-trips intact.
    expect(html).toContain('keywords:');
    expect(html).toContain('2FA, MFA, OTP');
    expect(html).toContain('&quot;'); // …and it IS escaped, not injected raw
    // Names concrete abbreviations — "add keywords" without an example reads as
    // boilerplate and gets skipped.
    for (const term of ['2FA', 'MFA', 'OTP']) expect(MEMORY_KEYWORDS_HINT).toContain(term);
    // ⛔ Keywords go LAST: `body_preview` is the first 280 chars and is what the
    // feed row shows, so a leading keywords line makes every entry preview as a
    // list of terms instead of its content.
    expect(MEMORY_BODY_PLACEHOLDER.indexOf('keywords:'))
      .toBeGreaterThan(MEMORY_BODY_PLACEHOLDER.indexOf('The answer'));
    // The summary prompt asks for the QUESTION, which is what real queries look
    // like — "How do I get a refund?" is found by more of them than "Refunds".
    expect(html).toContain('The question this answers');
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
    expect(html).toContain('tabindex="-1">Memory detail</h3>');
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

  it('shows Hide from AI (not Edit) on a run when writes are wired (§13)', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [audit], canWrite: true });
    expect(html).toContain('>Hide from AI<');
    expect(html).toMatch(new RegExp(`${MEMORY_DELETE_ACTION}[^>]*data-memory-id="run-1"`));
    expect(html).not.toContain(MEMORY_EDIT_ACTION); // others' rows aren't editable (§3)
  });

  it('renders a hidden run content-cleared + flagged, with no actions', () => {
    const redacted = entry({
      memory_id: 'run-9', origin_actor: 'contracted_user', kind: 'run', ts: 997_000,
      redacted: true, run_id: 'run-9',
    });
    const html = renderMemoryLens({ ...baseProps, entries: [redacted], canWrite: true });
    expect(html).toContain('Hidden from AI. Your Logs still show this run.');
    expect(html).toContain('is-redacted');
    expect(html).not.toContain('memory-delete'); // nothing left to act on: a run cannot be erased
  });

  it('detail: Hide from AI on a run; a hidden-state message on a hidden one', () => {
    const forgettable: MemoryDetailState = {
      memory_id: 'run-1', loading: false,
      entry: { memory_id: 'run-1', origin_actor: 'system', kind: 'run', ts: 1, summary: 'ran', run_id: 'run-1' },
    };
    expect(renderMemoryLens({ ...baseProps, entries: [], canWrite: true, detail: forgettable })).toContain('>Hide from AI<');
    const redacted: MemoryDetailState = {
      memory_id: 'run-2', loading: false,
      entry: { memory_id: 'run-2', origin_actor: 'system', kind: 'run', ts: 1, redacted: true, run_id: 'run-2' },
    };
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, detail: redacted });
    expect(html).toContain('Hidden from AI.');
    expect(html).not.toContain('>Hide from AI<');
  });
});

describe('renderMemoryLens — a run you started is the record of a run, not a note you wrote (D-198 §11)', () => {
  // `user_self` like a note you wrote, but audit-authored — `run_id` set, exactly
  // as `memory.list` projects a run the owner started. The server refuses to edit
  // it (409) and forgets it instead of deleting it.
  const ownRun = entry({
    memory_id: 'run-own', origin_actor: 'user_self', kind: 'run', ts: 998_000,
    summary: 'ran my recipe', run_id: 'run-own',
  });
  const ownNote = entry({
    memory_id: 'umem_mine', origin_actor: 'user_self', kind: 'note', ts: 999_000,
    has_body: true, body_preview: 'mine', size_bytes: 4,
  });
  const forgetButton = (id: string): RegExp =>
    new RegExp(`"${MEMORY_DELETE_ACTION}"[^>]*data-memory-id="${id}"[^>]*>Hide from AI<`);

  it('offers Hide from AI, never Edit or Delete, on your own run — while your note keeps both', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [ownNote, ownRun], canWrite: true });
    expect(html).not.toMatch(new RegExp(`${MEMORY_EDIT_ACTION}[^>]*data-memory-id="run-own"`));
    expect(html).toMatch(forgetButton('run-own'));
    expect(html).not.toMatch(/aria-label="Delete memory ran my recipe/);
    // the control: the same origin, written by you, is still yours to change
    expect(html).toMatch(new RegExp(`${MEMORY_EDIT_ACTION}[^>]*data-memory-id="umem_mine"`));
    expect(html).toMatch(/aria-label="Delete memory mine \(umem_mine\)"/);
    expect(html).not.toMatch(forgetButton('umem_mine'));
  });

  it('asks to hide your run from AI, not to delete it', () => {
    const html = renderMemoryLens({
      ...baseProps, entries: [ownRun], canWrite: true, pendingDeleteId: 'run-own',
    });
    expect(html).toContain('Hide this run from AI? Your Logs still show it in full.');
    expect(html).not.toContain('Delete this memory?');
  });

  it('detail: Hide from AI, not Edit, on your own run', () => {
    const detail: MemoryDetailState = {
      memory_id: 'run-own', loading: false,
      entry: { memory_id: 'run-own', origin_actor: 'user_self', kind: 'run', ts: 1, summary: 'ran', run_id: 'run-own' },
    };
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, detail });
    expect(html).toContain('>Hide from AI<');
    expect(html).not.toContain(MEMORY_EDIT_ACTION);
  });
});

describe('memory feed pagination', () => {
  /** ⛔ THE LENS NEVER ASKED FOR PAGE 2. `memory.list` has always returned a
   *  `next_cursor`; the route dropped it and the lens rendered nothing about
   *  there being more, so an owner past the first page saw the newest
   *  `DEFAULT_LIMIT` entries and no way to tell there were others. The lens
   *  header calls this feed "whole-feed", and `data.memory` is UNBOUNDED under
   *  D-230 (owner knowledge is never pruned) — one page is never the whole
   *  feed. */
  const withEntries = (over: Record<string, unknown>): string => renderMemoryLens({
    ...baseProps,
    entries: [entry({ memory_id: 'a', origin_actor: 'user_self', kind: 'note', ts: 999_000 })],
    ...over,
  } as never);

  it('⛔ offers Load more when the server reported another page', () => {
    expect(withEntries({ hasMore: true })).toContain(MEMORY_MORE_ACTION);
  });

  it('⛔ offers NOTHING when the feed ended — the button must not invite a dead click', () => {
    // A button that always renders returns an empty page at the end, which
    // reads as a broken feed rather than the end of one.
    expect(withEntries({ hasMore: false })).not.toContain(MEMORY_MORE_ACTION);
    expect(withEntries({})).not.toContain(MEMORY_MORE_ACTION);
  });

  it('⛔ shows the in-flight state and disables the button while paging', () => {
    // Without this a second click pages twice from the SAME cursor and
    // duplicates a page into the list.
    const html = withEntries({ hasMore: true, loadingMore: true });
    expect(html).toContain('Loading…');
    expect(html).toContain('aria-disabled="true"');
    // ⚠ `/memory-more[\s\S]*?disabled/` was too weak to discriminate — it also
    // matches `aria-disabled`, so a mutation dropping the real attribute passed.
    // Assert the BARE `disabled` that actually blocks the second click.
    expect(html).toMatch(/aria-disabled="true"\s+disabled>/);
    // ...and that it is gone when idle, or the button would never be clickable.
    expect(withEntries({ hasMore: true, loadingMore: false }))
      .not.toMatch(/aria-disabled="[^"]*"\s+disabled>/);
  });

  it('is absent on an EMPTY feed even if a cursor somehow survived', () => {
    // The empty-state copy already says there is nothing; a Load more beside it
    // would contradict it.
    const html = renderMemoryLens({ ...baseProps, entries: [], hasMore: true } as never);
    expect(html).not.toContain(MEMORY_MORE_ACTION);
  });
});

/** D-198 §10 — an agent's revisions, as the owner sees them. */
describe('renderMemoryLens — an agent replacing or forgetting its own entries', () => {
  const forgotten = entry({
    memory_id: 'umem_7', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 999_000,
    redacted: true, forgotten_by: 'your chat', forgotten_reason: 'the user asked me to',
  });
  const ownerRedacted = entry({
    memory_id: 'umem_8', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 999_000, redacted: true,
  });

  it('says who forgot an entry and why, and offers Restore only on an agent forget when writes are wired', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [forgotten, ownerRedacted], canWrite: true });
    expect(html).toContain('Forgotten by your chat. Reason: the user asked me to');
    expect(html).toMatch(new RegExp(`${MEMORY_RESTORE_ACTION}[^>]*data-memory-id="umem_7"`));
    expect(html).not.toMatch(new RegExp(`${MEMORY_RESTORE_ACTION}[^>]*data-memory-id="umem_8"`));
    expect(html).toContain('<p class="memory-row-redacted">Hidden, but its text is still on your server.</p>');
    expect(renderMemoryLens({ ...baseProps, entries: [forgotten], canWrite: false })).not.toContain(MEMORY_RESTORE_ACTION);
  });

  it('shows a busy Restore, and a failure on its own row', () => {
    const busy = renderMemoryLens({ ...baseProps, entries: [forgotten], canWrite: true, restoringId: 'umem_7' });
    expect(busy).toMatch(/data-memory-id="umem_7" aria-disabled="true" aria-busy="true"[^>]*>Restoring…</);
    const failed = renderMemoryLens({
      ...baseProps, entries: [forgotten], canWrite: true,
      restoreError: { memoryId: 'umem_7', message: 'no agent forgot that memory' },
    });
    expect(failed).toContain('role="alert">no agent forgot that memory</span>');
  });

  it('notes both ends of a replacement', () => {
    const html = renderMemoryLens({
      ...baseProps,
      entries: [
        entry({ memory_id: 'umem_6', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 999_500, summary: 'v2', replaces: 'umem_5' }),
        entry({ memory_id: 'umem_5', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 998_000, summary: 'v1', replaced_by: 'umem_6' }),
      ],
    });
    expect(html).toContain('<p class="memory-row-revision">Corrects an earlier entry</p>');
    expect(html).toContain('<p class="memory-row-revision">Replaced by a newer version</p>');
  });

  it("escapes the agent's reason (XSS guard)", () => {
    const html = renderMemoryLens({
      ...baseProps, canWrite: true,
      entries: [entry({ ...forgotten, forgotten_reason: '<img src=x onerror=alert(1)>' })],
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('the detail view of an agent-forgotten entry says who forgot it', () => {
    const detail: MemoryDetailState = {
      memory_id: 'umem_7', loading: false,
      entry: { memory_id: 'umem_7', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 999_000, redacted: true, forgotten_by: 'your chat' },
    };
    expect(renderMemoryLens({ ...baseProps, entries: [], detail })).toContain('Forgotten by your chat.');
  });
});

describe('renderMemoryLens — replacing an agent note with your own version (D-198 §12)', () => {
  const agentNote = entry({
    memory_id: 'umem_agent', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 998_000,
    summary: 'Dana prefers phone calls', has_body: true, body_preview: 'Dana prefers phone calls',
  });
  const replaceButton = (id: string): RegExp =>
    new RegExp(`<button[^>]*"${MEMORY_REPLACE_ACTION}"[^>]*data-memory-id="${id}"[^>]*>`);

  it('offers Replace beside Delete on a live, current agent note — never Edit', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [agentNote], canWrite: true });
    expect(html).toMatch(replaceButton('umem_agent'));
    expect(html).toMatch(/aria-label="Replace memory Dana prefers phone calls \(umem_agent\)">Replace</);
    expect(html).toContain('>Delete<');
    expect(html).not.toContain(MEMORY_EDIT_ACTION);
    // read-only mode offers nothing
    expect(renderMemoryLens({ ...baseProps, entries: [agentNote] })).not.toContain(MEMORY_REPLACE_ACTION);
  });

  it('⛔ offers no Replace on a run, a forgotten note, one already replaced, or your own note', () => {
    const entries = [
      entry({ memory_id: 'run-1', origin_actor: 'system', kind: 'run', ts: 1, run_id: 'run-1' }),
      entry({ memory_id: 'run-2', origin_actor: 'contracted_user', kind: 'run', ts: 2, run_id: 'run-2' }),
      entry({ memory_id: 'umem_gone', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 3, redacted: true }),
      entry({ memory_id: 'umem_old', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 4, replaced_by: 'umem_new' }),
      entry({ memory_id: 'umem_mine', origin_actor: 'user_self', kind: 'note', ts: 5 }),
    ];
    const html = renderMemoryLens({ ...baseProps, entries, canWrite: true });
    expect(html).not.toContain(MEMORY_REPLACE_ACTION);
    // the replaced one can still be forgotten; the controls did not vanish with Replace
    expect(html).toMatch(new RegExp(`"${MEMORY_DELETE_ACTION}"[^>]*data-memory-id="umem_old"[^>]*>Delete<`));
  });

  it('shows the prefill in flight on Replace, holds Delete, and keeps a failure on its own row', () => {
    const opening = renderMemoryLens({ ...baseProps, entries: [agentNote], canWrite: true, openingEditId: 'umem_agent' });
    const replace = opening.match(replaceButton('umem_agent'))?.[0] ?? '';
    expect(replace).toContain('aria-busy="true"');
    expect(opening).toContain('Opening…');
    expect(opening).toMatch(new RegExp(`"${MEMORY_DELETE_ACTION}"[^>]*aria-disabled="true"[^>]*>Delete<`));

    const failed = renderMemoryLens({
      ...baseProps, entries: [agentNote], canWrite: true,
      editError: { memoryId: 'umem_agent', message: '<server too old>' },
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('&lt;server too old&gt;');
  });

  it('names the act in the form, and says what saving does and how to undo it', () => {
    const compose: MemoryComposeState = {
      open: true, mode: 'replace', editId: 'umem_agent',
      kind: 'chat_memory', summary: 'Dana prefers email', body: '', submitting: false,
    };
    const html = renderMemoryLens({ ...baseProps, entries: [agentNote], canWrite: true, compose });
    expect(html).toContain('aria-label="Replace with your version"');
    expect(html).toContain('Saving puts your version in place of the agent’s');
    expect(html).toContain('Delete yours later and the agent’s comes back');
    expect(renderMemoryLens({ ...baseProps, entries: [], canWrite: true, compose: { ...compose, mode: 'create' } }))
      .not.toContain('in place of the agent’s');
  });

  it('detail: Replace beside Delete on an agent note', () => {
    const detail: MemoryDetailState = {
      memory_id: 'umem_agent', loading: false,
      entry: { memory_id: 'umem_agent', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 1, summary: 'Dana prefers phone calls', body: 'full' },
    };
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, detail });
    expect(html).toMatch(replaceButton('umem_agent'));
    expect(html).toContain('>Delete<');
  });
});

describe('renderMemoryLens — Delete on an agent note, Hide from AI on a run (D-198 §13)', () => {
  const agentNote = entry({
    memory_id: 'umem_agent', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 998_000,
    summary: 'Dana prefers phone calls',
  });
  const deleteButton = (id: string): RegExp =>
    new RegExp(`"${MEMORY_DELETE_ACTION}"[^>]*data-memory-id="${id}"[^>]*>Delete<`);

  it("asks before deleting an agent's note, and says the chat it came from keeps a copy", () => {
    const html = renderMemoryLens({ ...baseProps, entries: [agentNote], canWrite: true });
    expect(html).toMatch(deleteButton('umem_agent'));
    const pending = renderMemoryLens({ ...baseProps, entries: [agentNote], canWrite: true, pendingDeleteId: 'umem_agent' });
    expect(pending).toContain('Delete this memory? Its text leaves your server; the chat it came from keeps a copy.');
    expect(pending).toContain('aria-label="Confirm deleting memory Dana prefers phone calls (umem_agent)"');
  });

  it('shows a deleted note as who and when, with nothing left to act on', () => {
    const deleted = entry({
      memory_id: 'umem_gone', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 800_000,
      redacted: true, deleted_at: 1_000_000 - 2 * 86_400_000,
    });
    const html = renderMemoryLens({ ...baseProps, entries: [deleted], canWrite: true });
    expect(html).toContain('You deleted this 2d ago. Its text is gone from your server.');
    expect(html).not.toContain(MEMORY_DELETE_ACTION);
    expect(html).not.toContain(MEMORY_RESTORE_ACTION);
    expect(html).not.toContain(MEMORY_REPLACE_ACTION);
  });

  it('offers Delete on a note hidden before Delete existed — its text is still on the server — but not on an agent forget', () => {
    const hidden = entry({
      memory_id: 'umem_hidden', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 900_000, redacted: true,
    });
    const agentForgot = entry({
      memory_id: 'umem_forgot', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 900_000,
      redacted: true, forgotten_by: 'your chat',
    });
    const html = renderMemoryLens({ ...baseProps, entries: [hidden, agentForgot], canWrite: true });
    expect(html).toContain('Hidden, but its text is still on your server.');
    expect(html).toMatch(deleteButton('umem_hidden'));
    expect(html).not.toMatch(deleteButton('umem_forgot'));
    expect(html).toMatch(new RegExp(`${MEMORY_RESTORE_ACTION}[^>]*data-memory-id="umem_forgot"`));
    const pending = renderMemoryLens({ ...baseProps, entries: [hidden], canWrite: true, pendingDeleteId: 'umem_hidden' });
    expect(pending).toContain('Its text leaves your server');
    expect(pending).toContain(MEMORY_DELETE_CONFIRM_ACTION);
    expect(renderMemoryLens({ ...baseProps, entries: [hidden] })).not.toContain(MEMORY_DELETE_ACTION);
  });
});

describe('renderMemoryLens — Revoke and Un-revoke an agent note (D-198 §13)', () => {
  const live = entry({
    memory_id: 'umem_live', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 998_000,
    summary: 'Dana prefers phone calls',
  });
  const revoked = entry({
    memory_id: 'umem_wrong', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 900_000,
    summary: 'Dana prefers phone calls', revoked_at: 1_000_000 - 2 * 86_400_000,
  });
  const button = (action: string, id: string, label: string): RegExp =>
    new RegExp(`"${action}"[^>]*data-memory-id="${id}"[^>]*>${label}<`);

  it('offers Revoke between Replace and Delete on a live, current agent note', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [live], canWrite: true });
    expect(html).toMatch(button(MEMORY_REVOKE_ACTION, 'umem_live', 'Revoke'));
    expect(html.indexOf('>Replace<')).toBeLessThan(html.indexOf('>Revoke<'));
    expect(html.indexOf('>Revoke<')).toBeLessThan(html.indexOf('>Delete<'));
    expect(html).not.toContain(MEMORY_UNREVOKE_ACTION);
    expect(renderMemoryLens({ ...baseProps, entries: [live] })).not.toContain(MEMORY_REVOKE_ACTION);
  });

  it('keeps a revoked note readable, says what revoking it did, and offers Un-revoke, Replace and Delete', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [revoked], canWrite: true });
    expect(html).toContain('Dana prefers phone calls');
    expect(html).toContain('You revoked this 2d ago. AIs treat it as wrong and ask you before saving it again.');
    expect(html).toMatch(button(MEMORY_UNREVOKE_ACTION, 'umem_wrong', 'Un-revoke'));
    expect(html).not.toMatch(button(MEMORY_REVOKE_ACTION, 'umem_wrong', 'Revoke'));
    expect(html).toContain('>Replace<');
    expect(html).toContain('>Delete<');
    expect(html).not.toContain('is-redacted');
  });

  it('⛔ offers no Revoke on a run, your own note, or a version a newer one replaced', () => {
    const html = renderMemoryLens({
      ...baseProps,
      canWrite: true,
      entries: [
        entry({ memory_id: 'run-1', origin_actor: 'system', kind: 'run', ts: 1, run_id: 'run-1' }),
        entry({ memory_id: 'umem_mine', origin_actor: 'user_self', kind: 'note', ts: 2 }),
        entry({ memory_id: 'umem_old', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 3, replaced_by: 'umem_new' }),
      ],
    });
    expect(html).not.toContain(MEMORY_REVOKE_ACTION);
    expect(html).not.toContain(MEMORY_UNREVOKE_ACTION);
  });

  it('shows the act in flight on its own button, and a failure on its own row', () => {
    const busy = renderMemoryLens({ ...baseProps, entries: [live], canWrite: true, restoringId: 'umem_live' });
    expect(busy).toMatch(new RegExp(`"${MEMORY_REVOKE_ACTION}"[^>]*aria-busy="true"[^>]*>Revoking…<`));
    const failed = renderMemoryLens({
      ...baseProps, entries: [revoked], canWrite: true,
      restoreError: { memoryId: 'umem_wrong', message: '<needs an update>' },
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('&lt;needs an update&gt;');
  });

  it('detail: Revoke on a live agent note, Un-revoke and the revoked line on a revoked one', () => {
    const detailOf = (e: MemoryListEntry): MemoryDetailState => ({
      memory_id: e.memory_id, loading: false, entry: { ...e, body: 'full' },
    });
    expect(renderMemoryLens({ ...baseProps, entries: [], canWrite: true, detail: detailOf(live) }))
      .toMatch(button(MEMORY_REVOKE_ACTION, 'umem_live', 'Revoke'));
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, detail: detailOf(revoked) });
    expect(html).toMatch(button(MEMORY_UNREVOKE_ACTION, 'umem_wrong', 'Un-revoke'));
    expect(html).toContain('You revoked this 2d ago.');
  });
});

describe("the Delete confirm's count (D-198 §13)", () => {
  const live = entry({
    memory_id: 'umem_live', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 998_000,
    summary: "Dana Whitfield's daughter is called Mia",
  });
  const button = (action: string, id: string, label: string): RegExp =>
    new RegExp(`"${action}"[^>]*data-memory-id="${id}"[^>]*>${label}<`);
  const PLAIN = 'Delete this memory? Its text leaves your server; the chat it came from keeps a copy.';

  it('says "Checking…" on Delete while it asks how often the note was saved', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [live], canWrite: true, checkingDeleteId: 'umem_live' });
    expect(html).toMatch(new RegExp(`"${MEMORY_DELETE_ACTION}"[^>]*aria-disabled="true" aria-busy="true"[^>]*>Checking…<`));
    expect(html).not.toContain(MEMORY_DELETE_CONFIRM_ACTION);
  });

  it('saved more than once by one agent: asks to mark it wrong, and names what each button does', () => {
    const html = renderMemoryLens({
      ...baseProps, entries: [live], canWrite: true, pendingDeleteId: 'umem_live', deleteSaves: { saves: 3, agents: 1 },
    });
    expect(html).toContain(
      'An agent has saved this 3 times. Mark it wrong so it asks you first? '
      + 'If you delete it, its text leaves your server; the chat it came from keeps a copy.',
    );
    expect(html).toMatch(button(MEMORY_REVOKE_ACTION, 'umem_live', 'Mark it wrong'));
    expect(html).toMatch(button(MEMORY_DELETE_CONFIRM_ACTION, 'umem_live', 'Delete'));
    expect(html).toMatch(button(MEMORY_DELETE_CANCEL_ACTION, 'umem_live', 'Cancel'));
    // Each button's name holds the words it shows.
    expect(html).toMatch(/aria-label="Mark it wrong Dana Whitfield&#39;s daughter is called Mia \(umem_live\)"/);
    expect(html).toMatch(/aria-label="Delete memory Dana Whitfield&#39;s daughter is called Mia \(umem_live\)"/);
    expect(html.indexOf('>Mark it wrong<')).toBeLessThan(html.indexOf('>Delete<'));
    expect(html).not.toContain(PLAIN);
  });

  it('saved by several agents, it says they', () => {
    expect(renderMemoryLens({
      ...baseProps, entries: [live], canWrite: true, pendingDeleteId: 'umem_live', deleteSaves: { saves: 4, agents: 2 },
    })).toContain('Agents have saved this 4 times. Mark it wrong so they ask you first?');
  });

  it('while it deletes, Mark it wrong is held too', () => {
    const html = renderMemoryLens({
      ...baseProps, entries: [live], canWrite: true, pendingDeleteId: 'umem_live', deletingId: 'umem_live',
      deleteSaves: { saves: 3, agents: 1 },
    });
    expect(html).toMatch(new RegExp(`"${MEMORY_REVOKE_ACTION}"[^>]*aria-disabled="true"[^>]*>Mark it wrong<`));
    expect(html).toMatch(new RegExp(`"${MEMORY_DELETE_CONFIRM_ACTION}"[^>]*aria-busy="true"[^>]*>Deleting…<`));
  });

  it('⛔ a count on a note it could not mark wrong changes nothing: the confirm it always had', () => {
    for (const other of [
      entry({ memory_id: 'umem_live', origin_actor: 'user_self', kind: 'note', ts: 1, summary: 'mine' }),
      { ...live, revoked_at: 900_000 },
      { ...live, replaced_by: 'umem_new' },
    ]) {
      const html = renderMemoryLens({
        ...baseProps, entries: [other], canWrite: true, pendingDeleteId: 'umem_live', deleteSaves: { saves: 3, agents: 1 },
      });
      expect(html).not.toContain('Mark it wrong');
      expect(html).toMatch(button(MEMORY_DELETE_CONFIRM_ACTION, 'umem_live', 'Confirm'));
    }
  });

  it('detail: the same Checking… and the same question', () => {
    const detail: MemoryDetailState = { memory_id: 'umem_live', loading: false, entry: { ...live, body: 'full' } };
    expect(renderMemoryLens({ ...baseProps, entries: [], canWrite: true, detail, checkingDeleteId: 'umem_live' }))
      .toMatch(new RegExp(`"${MEMORY_DELETE_ACTION}"[^>]*aria-busy="true"[^>]*>Checking…<`));
    const html = renderMemoryLens({
      ...baseProps, entries: [], canWrite: true, detail, pendingDeleteId: 'umem_live', deleteSaves: { saves: 2, agents: 1 },
    });
    expect(html).toContain('An agent has saved this 2 times. Mark it wrong so it asks you first?');
    expect(html).toMatch(new RegExp(`class="memory-btn"\\s+data-recued-data-action="${MEMORY_REVOKE_ACTION}"[^>]*>Mark it wrong<`));
    expect(html).toMatch(button(MEMORY_DELETE_CONFIRM_ACTION, 'umem_live', 'Delete'));
  });
});

describe('D-336 slice E — the relationship in the compose form', () => {
  const compose = { open: true, mode: 'create' as const, kind: 'fact', summary: '', body: '', submitting: false };
  const render = (claim: { subject: unknown; relation: string; object: unknown }) =>
    renderMemoryLens({ ...baseProps, entries: [], canWrite: true, compose: { ...compose, claim: claim as never } });
  const endHtml = (html: string, end: 'subject' | 'object') => {
    const start = html.indexOf(`id="memory-claim-${end}"`);
    const next = html.indexOf(end === 'subject' ? 'id="memory-claim-relation"' : 'Remove relationship', start);
    return html.slice(start, next);
  };

  it('offers to add one when the note has none', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [], canWrite: true, compose });
    expect(html).toContain('Add a relationship');
    expect(html).toContain('Also say the fact as a relationship, such as Mia, daughter of, Dana.');
  });

  /** What an end says its relation takes there (`MEMORY_CLAIM_TAKES_ATTR`). */
  const takes = (html: string, end: 'subject' | 'object') =>
    new RegExp(`data-memory-claim-part="${end}" ${MEMORY_CLAIM_TAKES_ATTR}="(\\w+)"`).exec(html)?.[1];

  it("offers each end the links its relation takes there: a person a contact or you, a thing a thing you own", () => {
    // Every link is drawn, marked with what it links to, and each end says what its relation
    // takes; the styles hide the rest, so a relation typed changes them in place.
    const owns = render({ subject: { text: 'Mia' }, relation: 'owns', object: { text: 'bike' } });
    expect(endHtml(owns, 'subject')).toContain(`${MEMORY_CLAIM_OFFER_ATTR}="person">Link to a contact`);
    expect(endHtml(owns, 'subject')).toContain(`${MEMORY_CLAIM_OFFER_ATTR}="person">That’s you`);
    expect(endHtml(owns, 'subject')).toContain(`${MEMORY_CLAIM_OFFER_ATTR}="thing">Link to a thing you own`);
    expect([takes(owns, 'subject'), takes(owns, 'object')]).toEqual(['person', 'thing']);
    // Words a place takes: no link at all.
    expect(takes(render({ subject: { text: 'Dana' }, relation: 'lives in', object: { text: 'Cork' } }), 'object')).toBe('none');
    // A relation of the owner's own says nothing of its ends, so both are offered; so does none yet.
    expect(takes(render({ subject: { text: 'Lena' }, relation: "mother of my cousin's boyfriend", object: { text: 'Sara' } }), 'object')).toBe('any');
    expect(takes(render({ subject: { text: '' }, relation: '', object: { text: '' } }), 'subject')).toBe('any');
    // The lens's styles hide what an end does not take.
    expect(MEMORY_LENS_STYLES).toContain(MEMORY_CLAIM_TAKES_STYLES);
    for (const hidden of [
      `[${MEMORY_CLAIM_TAKES_ATTR}="person"] [${MEMORY_CLAIM_OFFER_ATTR}="thing"]`,
      `[${MEMORY_CLAIM_TAKES_ATTR}="thing"] [${MEMORY_CLAIM_OFFER_ATTR}="person"]`,
      `[${MEMORY_CLAIM_TAKES_ATTR}="none"] [${MEMORY_CLAIM_OFFER_ATTR}]`,
    ]) expect(MEMORY_CLAIM_TAKES_STYLES).toContain(hidden);
  });

  it('a relation being typed sets what each end takes in place, without a redraw', () => {
    const ends = new Map(['subject', 'object'].map((end) => [end, new Map<string, string>([[MEMORY_CLAIM_TAKES_ATTR, 'any']])]));
    const within = {
      querySelector: (selector: string) => {
        const end = /data-memory-claim-part="(\w+)"/.exec(selector)?.[1];
        const attrs = end === undefined ? undefined : ends.get(end);
        return attrs === undefined ? null : { setAttribute: (k: string, v: string) => { attrs.set(k, v); } };
      },
    } as unknown as ParentNode;
    showMemoryClaimTakes(within, 'owns');
    expect([ends.get('subject')!.get(MEMORY_CLAIM_TAKES_ATTR), ends.get('object')!.get(MEMORY_CLAIM_TAKES_ATTR)]).toEqual(['person', 'thing']);
    showMemoryClaimTakes(within, 'lives in');
    expect(ends.get('object')!.get(MEMORY_CLAIM_TAKES_ATTR)).toBe('none');
    showMemoryClaimTakes(within, '  ');
    expect(ends.get('object')!.get(MEMORY_CLAIM_TAKES_ATTR)).toBe('any');
    showMemoryClaimTakes(undefined, 'owns');
  });

  it('lists every relation to choose from, by group, and takes the owner\'s own words', () => {
    const html = render({ subject: { text: '' }, relation: '', object: { text: '' } });
    expect(html).toContain('<option value="daughter of" label="Family"></option>');
    expect(html).toContain('<option value="owns" label="Things"></option>');
    expect(html).toContain('Choose one from the list, or write your own words.');
  });

  it('shows a linked end by its name, with a way to unlink it', () => {
    const html = render({ subject: { text: 'Mia' }, relation: 'daughter of', object: { contact_id: 'ct-1', name: 'Dana Whitfield' } });
    expect(html).toContain('data-memory-claim-linked="object"');
    expect(html).toContain('Dana Whitfield<span class="memory-field-hint"> · a contact</span>');
    expect(html).toContain('>Unlink</button>');
    expect(render({ subject: { owner: true }, relation: 'owns', object: { text: 'bike' } })).toContain('<span class="memory-claim-linked">You');
  });

  /** D-336 slice H — the picker makes the contact when there is none (§3.6). */
  it('offers to add the name as a contact where the search found nobody, and says while it is added', () => {
    const claim = { subject: { text: 'Mia <3' }, relation: 'daughter of', object: { text: 'Dana' } };
    const withLinking = (linking: Record<string, unknown>) => renderMemoryLens({
      ...baseProps, entries: [], canWrite: true,
      compose: { ...compose, claim: claim as never, linking: { end: 'subject', kind: 'contact', loading: false, options: [], ...linking } as never },
    });
    const offered = endHtml(withLinking({ error: 'No contact matches “Mia <3”.', addable: 'Mia <3' }), 'subject');
    expect(offered).toContain(`${MEMORY_CLAIM_ADD_CONTACT_ACTION}" data-memory-claim-end="subject">Add “Mia &lt;3” as a contact</button>`);
    // Before the Cancel that leaves the search.
    expect(offered.indexOf('as a contact')).toBeLessThan(offered.indexOf('>Cancel</button>'));
    const adding = endHtml(withLinking({ addable: 'Mia <3', adding: true }), 'subject');
    expect(adding).toContain('<p class="memory-field-hint" role="status">Adding “Mia &lt;3”…</p>');
    expect(adding).not.toContain(MEMORY_CLAIM_ADD_CONTACT_ACTION);
    // Matches found, or a search that failed: nothing to add.
    const found = endHtml(withLinking({ options: [{ id: 'ct-1', name: 'Mia Whitfield' }] }), 'subject');
    expect(found).not.toContain(MEMORY_CLAIM_ADD_CONTACT_ACTION);
    expect(endHtml(withLinking({ error: 'Your server is busy right now.' }), 'subject')).not.toContain(MEMORY_CLAIM_ADD_CONTACT_ACTION);
  });

  /** D-336 slice L — the picker makes the thing when there is none. */
  it('offers to add the name as a thing you own where the search found nothing, with an action of its own', () => {
    const claim = { subject: { owner: true }, relation: 'owns', object: { text: 'Rex <3' } };
    const offered = endHtml(renderMemoryLens({
      ...baseProps, entries: [], canWrite: true,
      compose: { ...compose, claim: claim as never, linking: {
        end: 'object', kind: 'asset', loading: false, options: [], error: 'Nothing you own matches “Rex <3”.', addable: 'Rex <3', addKey: 'k1',
      } as never },
    }), 'object');
    expect(offered).toContain(`${MEMORY_CLAIM_ADD_THING_ACTION}" data-memory-claim-end="object">Add “Rex &lt;3” as a thing you own</button>`);
    expect(offered).not.toContain(MEMORY_CLAIM_ADD_CONTACT_ACTION);
  });

  /** Audit 2026-11-01 — a lookup or an add under way is dropped when the owner changes the
   *  relationship, and its matches with it, in place. */
  it('an end\'s matches are marked by their end, and come off the form in place', () => {
    const claim = { subject: { text: 'Mia' }, relation: 'daughter of', object: { text: 'Dana' } };
    const html = renderMemoryLens({
      ...baseProps, entries: [], canWrite: true,
      compose: { ...compose, claim: claim as never, linking: { end: 'object', kind: 'contact', loading: true, options: [] } as never },
    });
    expect(endHtml(html, 'object')).toContain(`<div class="memory-claim-matches" ${MEMORY_CLAIM_MATCHES_ATTR}="object" role="group"`);
    expect(endHtml(html, 'subject')).not.toContain(MEMORY_CLAIM_MATCHES_ATTR);
    const asked: string[] = [];
    let removed = 0;
    const host = { querySelector: (selector: string) => { asked.push(selector); return { remove: () => { removed += 1; } }; } };
    dropMemoryClaimMatches(host as unknown as ParentNode, 'object');
    expect(asked).toEqual([`[${MEMORY_CLAIM_MATCHES_ATTR}="object"]`]);
    expect(removed).toBe(1);
    // No form, or no matches drawn: nothing to take off.
    dropMemoryClaimMatches(undefined, 'object');
    dropMemoryClaimMatches({ querySelector: () => null } as unknown as ParentNode, 'subject');
  });
});

describe('D-336 slice G — the Memory view marks a note that contradicts another', () => {
  const sister = entry({
    memory_id: 'umem_sister', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 998_000,
    summary: "Mia is Dana's sister.",
    contradicts: [{ memory_id: 'umem_daughter', summary: "Mia is <Dana>'s daughter." }],
  });

  it('says what each contradicts, by its summary, opening that note', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [sister] });
    expect(html).toContain('<p class="memory-row-revision" data-memory-contradicts>Contradicts '
      + '<a href="#data/memory/umem_daughter">"Mia is &lt;Dana&gt;&#39;s daughter."</a></p>');
  });

  it('names two in one line, and says nothing for a note with none', () => {
    const two = entry({
      memory_id: 'umem_x', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 1,
      summary: 'x', contradicts: [{ memory_id: 'umem_a', summary: 'A.' }, { memory_id: 'umem_b', summary: 'B.' }],
    });
    expect(renderMemoryLens({ ...baseProps, entries: [two] })).toMatch(/Contradicts <a [^>]*>"A\."<\/a> and <a [^>]*>"B\."<\/a>/);
    expect(renderMemoryLens({ ...baseProps, entries: [entry({ memory_id: 'umem_y', origin_actor: 'user_self', kind: 'note', ts: 1 })] }))
      .not.toContain('data-memory-contradicts');
  });

  it('marks the detail view too', () => {
    const html = renderMemoryLens({ ...baseProps, entries: [], detail: { memory_id: 'umem_sister', loading: false, entry: { ...sister, body: 'full' } } });
    expect(html).toContain('data-memory-contradicts>Contradicts <a href="#data/memory/umem_daughter">');
  });
});

describe('D-336 slice T — a relationship\'s ends told apart: a record, or a name in words', () => {
  const daughter = entry({
    memory_id: 'umem_daughter', origin_actor: 'contracted_user', kind: 'chat_memory', ts: 998_000,
    summary: "Mia is Dana's daughter.",
    claim: { subject: { text: 'Mia' }, relation: 'daughter of', object: { contact_id: 'ct-dana', name: 'Dana <W>' } },
  });
  const WORDS = (text: string) => `<span class="memory-claim-tag memory-claim-tag--words" data-memory-claim-end-is="words">“${text}”`
    + '<span class="memory-claim-tag-kind">not linked</span></span>';
  const detailOf = (row: MemoryListEntry, canWrite = true) =>
    renderMemoryLens({ ...baseProps, entries: [], canWrite, detail: { memory_id: row.memory_id, loading: false, entry: { ...row, body: 'full' } } });

  it('the list shows each note\'s relationship: a contact, a thing or you as a record, a name in words as not linked', () => {
    const car = entry({
      memory_id: 'umem_car', origin_actor: 'user_self', kind: 'note', ts: 997_000, summary: 'I own the family car.',
      claim: { subject: { owner: true }, relation: 'owns', object: { asset_id: 'asset-car', name: 'Family car' } },
    });
    const html = renderMemoryLens({ ...baseProps, entries: [daughter, car, entry({ memory_id: 'umem_plain', origin_actor: 'user_self', kind: 'note', ts: 1, summary: 'plain' })] });
    // A contact's tag opens its page, by its id, which the contact page looks up.
    expect(html).toContain(`<p class="memory-row-claim" data-memory-claim-line>${WORDS('Mia')} <span class="memory-claim-relation">daughter of</span> `
      + '<a class="memory-claim-tag memory-claim-tag--record" data-memory-claim-end-is="contact" href="#data/contact/ct-dana">Dana &lt;W&gt;'
      + '<span class="memory-claim-tag-kind">contact</span></a></p>');
    expect(html).toContain('<span class="memory-claim-tag memory-claim-tag--record" data-memory-claim-end-is="owner">You</span> '
      + '<span class="memory-claim-relation">owns</span> <span class="memory-claim-tag memory-claim-tag--record" data-memory-claim-end-is="asset">'
      + 'Family car<span class="memory-claim-tag-kind">thing you own</span></span>');
    // A note saved with no relationship has no line.
    expect(html.match(/data-memory-claim-line/g)).toHaveLength(2);
  });

  // D-336 (spec §45) — a thing's tag opens its page in Yours, by the id it keeps for a thing of its own.
  it("a thing's tag opens its page when its id is Recued's own, and stays a tag otherwise", () => {
    const thing = (asset_id: string) => renderMemoryLens({ ...baseProps, entries: [entry({
      memory_id: `umem_${asset_id.length}`, origin_actor: 'user_self', kind: 'note', ts: 1, summary: 'mine',
      claim: { subject: { owner: true }, relation: 'owns', object: { asset_id, name: 'Family car' } },
    })] });
    const local = qualifyWorkEntityId({ kind: 'asset', source_id: 'recued.asset', local_id: 'asset-car' });
    expect(thing(local)).toContain('<a class="memory-claim-tag memory-claim-tag--record" data-memory-claim-end-is="asset" '
      + 'href="#yours/asset/asset-car">Family car<span class="memory-claim-tag-kind">thing you own</span></a>');
    // From a source, the page knows it by another id; an id of another form, or a broken one, links nowhere.
    const sourced = qualifyWorkEntityId({ kind: 'asset', source_id: 'home-assistant', source_record_id: 'sensor.car', local_id: 'asset-car' });
    for (const id of [sourced, 'asset-car', `${local.split(':').slice(0, 3).join(':')}:broken`]) {
      expect(thing(id)).toContain('<span class="memory-claim-tag memory-claim-tag--record" data-memory-claim-end-is="asset">Family car');
      expect(thing(id)).not.toContain('href="#yours/asset/');
    }
  });

  it('the detail says how to link a name in words: Replace for an AI\'s note, Edit for the owner\'s own', () => {
    expect(detailOf(daughter)).toContain('<p class="memory-detail-claim-hint">“Mia” is not linked, so Recued matches it only with notes '
      + 'in the same words. To link it, choose Replace.</p>');
    const own = entry({ ...daughter, memory_id: 'umem_own', origin_actor: 'user_self', kind: 'note',
      claim: { subject: { text: 'Mia' }, relation: 'daughter of', object: { text: 'Dana' } } });
    expect(detailOf(own)).toContain('“Mia” and “Dana” are not linked, so Recued matches them only with notes in the same words. '
      + 'To link them, choose Edit.');
    expect(detailOf(own)).toContain(`${WORDS('Mia')} <span class="memory-claim-relation">daughter of</span> ${WORDS('Dana')}`);
  });

  it('says nothing of linking where it cannot be: a place in words, every end linked, or no way to change the note', () => {
    const home = entry({ ...daughter, memory_id: 'umem_home', claim: { subject: { contact_id: 'ct-dana', name: 'Dana' }, relation: 'lives in', object: { text: 'Dublin' } } });
    expect(detailOf(home)).toContain('data-memory-claim-line');
    expect(detailOf(home)).not.toContain('memory-detail-claim-hint');
    const linked = entry({ ...daughter, memory_id: 'umem_linked', claim: { subject: { contact_id: 'ct-mia', name: 'Mia' }, relation: 'daughter of', object: { contact_id: 'ct-dana', name: 'Dana' } } });
    expect(detailOf(linked)).not.toContain('memory-detail-claim-hint');
    expect(detailOf(daughter, false)).not.toContain('memory-detail-claim-hint');
  });
});

describe('D-336 slice K — the Memory view says what the relation list misses', () => {
  const counts = (over: Partial<{ agent_notes: number; agent_notes_without_claim: number; own_relations: Array<{ relation: string; notes: number }> }> = {}) => ({
    agent_notes: 12, agent_notes_without_claim: 3, own_relations: [], ...over,
  });

  it("names the notes an AI saved without a relationship, and the owner's own relations with their counts", () => {
    expect(renderClaimCounts(counts())).toContain('3 of the 12 notes an AI saved have no relationship. Replace one to add it.');
    expect(renderClaimCounts(counts({ agent_notes_without_claim: 1 }))).toContain('1 of the 12 notes an AI saved has no relationship.');
    expect(renderClaimCounts(counts({ agent_notes: 1, agent_notes_without_claim: 1 })))
      .toContain('The note an AI saved has no relationship. Replace it to add one.');
    const own = renderClaimCounts(counts({ agent_notes_without_claim: 0, own_relations: [{ relation: 'taught piano to', notes: 2 }, { relation: 'walks <b>', notes: 1 }] }));
    expect(own).toContain('Relations in your own words: "taught piano to" (2), "walks &lt;b&gt;" (1).');
    expect(own).not.toContain('no relationship');
  });

  it('names five of the own relations and counts the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ relation: `relation ${String(i)}`, notes: 1 }));
    expect(renderClaimCounts(counts({ agent_notes_without_claim: 0, own_relations: many }))).toContain('"relation 4" (1), and 2 more.');
  });

  it('says nothing when there is nothing to say, and only in the list', () => {
    expect(renderClaimCounts(counts({ agent_notes_without_claim: 0 }))).toBe('');
    const list = renderMemoryLens({ ...baseProps, entries: [], claimCounts: counts() });
    expect(list).toContain(MEMORY_CLAIM_COUNTS_ATTR);
    expect(renderMemoryLens({ ...baseProps, entries: [] })).not.toContain(MEMORY_CLAIM_COUNTS_ATTR);
    const composing = renderMemoryLens({
      ...baseProps, entries: [], claimCounts: counts(), canWrite: true,
      compose: { open: true, kind: 'note', summary: '', body: '' } as never,
    });
    expect(composing).not.toContain(MEMORY_CLAIM_COUNTS_ATTR);
  });
});
