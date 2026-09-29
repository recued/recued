/** D-145 PA6 — list-view rendering.
 *
 *  Pin per § Phase PA6 (List/search view per Source):
 *    - Renders search input bound to search_query.
 *    - Renders one row per entity with primary text + meta.
 *    - Source label appears per-row only in show_source_label mode.
 *    - data-action="open-edit-work-entity" + data-entity-id + data-source-id.
 *    - Empty state distinguishes "no rows" vs "no match for query".
 *    - XSS-safe (title / body escape).
 */

import { describe, expect, it } from 'vitest';

import {
  type SourceDropdownOption,
  type WorkEntity,
  type WorkEntityListRow,
} from '@recued/contracts';

import { projectRowText, renderWorkEntityListView } from '../work-entity-page/list-view.js';

const NOW = 1_700_000_000_000;

const taskRow = (over: Partial<WorkEntity & { _kind: 'task' }>): WorkEntity =>
  ({
    _kind: 'task',
    id: over.id ?? 'task-1',
    title: 'A task',
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

const sourceOpt = (over: Partial<SourceDropdownOption> = {}): SourceDropdownOption => ({
  id: 'recued.task',
  label: 'Recued built-in (task)',
  source_kind: 'builtin',
  write_capable: true,
  ...over,
});

const row = (over: Partial<WorkEntity & { _kind: 'task' }>): WorkEntityListRow => ({
  entity: taskRow(over),
  source: sourceOpt(),
});

describe('D-145 PA6 — renderWorkEntityListView (list)', () => {
  it('renders a search input bound to search_query', () => {
    const html = renderWorkEntityListView({
      kind: 'task',
      rows: [],
      show_source_label: false,
      search_query: 'milk',
    });
    expect(html).toContain('data-action="search-work-entities"');
    expect(html).toContain('value="milk"');
  });

  it('renders one row per entity with primary text + data attributes', () => {
    const rows: WorkEntityListRow[] = [
      row({ id: 'a', title: 'Buy milk' }),
      row({ id: 'b', title: 'Email Bob' }),
    ];
    const html = renderWorkEntityListView({
      kind: 'task',
      rows,
      show_source_label: false,
      search_query: '',
    });
    expect(html).toContain('data-entity-id="a"');
    expect(html).toContain('data-entity-id="b"');
    expect(html).toMatch(/data-action="open-edit-work-entity"/);
    expect(html).toContain('Buy milk');
    expect(html).toContain('Email Bob');
  });

  it('keeps the opening row focusable and exposes its busy state', () => {
    const html = renderWorkEntityListView({
      kind: 'task',
      rows: [row({ id: 'a', title: 'Buy milk' })],
      show_source_label: false,
      search_query: '',
      opening_entity_id: 'a',
    });
    const button = html.match(
      /<button[^>]*data-entity-id="a"[^>]*>[\s\S]*?<\/button>/,
    )?.[0] ?? '';
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('aria-busy="true"');
    expect(button).not.toMatch(/\sdisabled(?:\s|=|>)/);
    expect(button).toContain('Opening…');
  });

  it('omits Source label per row when show_source_label is false', () => {
    const html = renderWorkEntityListView({
      kind: 'task',
      rows: [row({ id: 'a', title: 'Buy milk' })],
      show_source_label: false,
      search_query: '',
    });
    expect(html).not.toContain('class="work-entity-list-row-source"');
  });

  it('renders Source label per row when show_source_label is true', () => {
    const html = renderWorkEntityListView({
      kind: 'task',
      rows: [row({ id: 'a', title: 'Buy milk' })],
      show_source_label: true,
      search_query: '',
    });
    expect(html).toContain('class="work-entity-list-row-source"');
    expect(html).toContain('Recued built-in (task)');
  });

  it('every row carries data-source-id from the entity row (not the source option)', () => {
    const html = renderWorkEntityListView({
      kind: 'task',
      rows: [
        {
          entity: taskRow({ id: 'a', source_id: 'hubspot.acme.task' }),
          source: sourceOpt({ id: 'hubspot.acme.task' }),
        },
      ],
      show_source_label: true,
      search_query: '',
    });
    expect(html).toContain('data-source-id="hubspot.acme.task"');
  });

  it('escapes HTML in entity title + body', () => {
    const html = renderWorkEntityListView({
      kind: 'task',
      rows: [
        row({
          id: 'a',
          title: '<script>1</script>',
          body: '<img onerror=alert(1)>',
        }),
      ],
      show_source_label: false,
      search_query: '',
    });
    expect(html).not.toContain('<script>1</script>');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders default empty-state copy when no rows + no query', () => {
    const html = renderWorkEntityListView({
      kind: 'task',
      rows: [],
      show_source_label: false,
      search_query: '',
      empty_state_copy: 'Nothing yet.',
    });
    expect(html).toContain('work-entity-list-empty-default');
    expect(html).toContain('Nothing yet.');
  });

  it('renders no-match empty state when query is non-empty + zero rows', () => {
    const html = renderWorkEntityListView({
      kind: 'task',
      rows: [],
      show_source_label: false,
      search_query: 'zzz',
    });
    expect(html).toContain('work-entity-list-empty-no-match');
    expect(html).toContain('<strong>zzz</strong>');
  });
});

describe('D-267 follow-on — the row says what only Recued can say', () => {
  const commitment = (
    over: Partial<WorkEntity & { _kind: 'commitment' }> = {},
  ): WorkEntityListRow => ({
    entity: {
      _kind: 'commitment', id: 'c1', statement: 'Send Maya the draft',
      direction: 'outbound', derivation: 'user_declared',
      lifecycle_state: 'pending', due_status: 'not_due',
      expiry_policy: 'escalate_overdue', promised_at: 1, state_changed_at: 1,
      lifecycle_changed_at: 1, due_status_changed_at: 1,
      blocks_task_ids: [], blocks_project_ids: [],
      source_id: 'recued.commitment', last_seen_at: 1, sync_state: 'live',
      conflict_policy: 'recued_wins', created_at: 1, updated_at: 1,
      ...over,
    } as WorkEntity,
    source: { id: 'recued.commitment', label: 'Recued', source_kind: 'builtin', write_capable: true },
  });

  it('⛔ a clean, hand-made row says NOTHING — the default origin is not a badge', () => {
    // `user_declared` is what every row of a fresh install carries. Badging it
    // would print "you declared this" on every line of the one screen that has
    // nothing else to read — noise dressed as provenance.
    const html = renderWorkEntityListView({
      kind: 'commitment', rows: [commitment()], show_source_label: true, search_query: '',
    });
    expect(html).not.toContain('work-entity-list-row-badge');
  });

  it('names an origin that is NOT you, which is the whole point', () => {
    for (const [derivation, label] of [
      ['mail_extracted', 'From mail'],
      ['recipe_emitted', 'From a recipe'],
      ['peer_received', 'From a peer'],
    ] as const) {
      const html = renderWorkEntityListView({
        kind: 'commitment', rows: [commitment({ derivation })],
        show_source_label: true, search_query: '',
      });
      expect(html).toContain(label);
    }
  });

  it('⛔ flags a source it cannot reach, in Today\'s exact words', () => {
    const html = renderWorkEntityListView({
      kind: 'commitment', rows: [commitment({ sync_state: 'stale_unreachable' })],
      show_source_label: true, search_query: '',
    });
    // ⚠ Two surfaces describing one fact differently is worse than either
    // wording — Today already calls this "Recued cannot reach this source".
    expect(html).toContain('Recued cannot reach this source');
    expect(html).toContain('data-warning');
  });

  it('flags an edit that has not reached its source', () => {
    const html = renderWorkEntityListView({
      kind: 'commitment',
      rows: [commitment({
        pending_write: { staged_at: 1, operation: 'update', dirty_fields: ['statement'], state: 'pending' },
      })],
      show_source_label: true, search_query: '',
    });
    expect(html).toContain('Change not sent yet');
  });

  it('⚠ says nothing about origin for the four kinds that store none', () => {
    // Task / note / project / booking have NO origin field — their provenance
    // lives in the audit trail, not on the row. Asserting that here keeps the
    // gap visible instead of letting a future reader assume it is covered.
    const html = renderWorkEntityListView({
      kind: 'task', rows: [row({ id: 't1', title: 'Ship it' })],
      show_source_label: true, search_query: '',
    });
    expect(html).not.toContain('work-entity-list-row-badge');
  });
});

describe('a task row\'s due date', () => {
  const task = (due_at: number) => ({
    _kind: 'task', id: 't', title: 'File the return', done: false, due_at,
    source_id: 'recued.task', sync_state: 'live', conflict_policy: 'recued_wins',
    last_seen_at: 1, created_at: 1, updated_at: 1, blocks_task_ids: [],
  }) as never;

  it('prints a whole-DAY due (UTC midnight) as that day', () => {
    expect(projectRowText(task(Date.UTC(2026, 8, 28))).meta).toContain('Due 2026-09-28');
  });

  it('prints a timed due as the date it falls on HERE, as the filter hint promises', () => {
    const at = new Date(2026, 8, 27, 23, 30).getTime() + 1; // late Sunday, local
    expect(projectRowText(task(at)).meta).toContain('Due 2026-09-27');
  });
});
