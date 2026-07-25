/** D-145 PA11 — Settings → Work Entities panel render tests.
 *
 *  Pure-render tests: shape the props, render, and assert on the
 *  resulting HTML. The host is responsible for wiring the
 *  `data-action` clicks to the rpc dispatcher; this surface only
 *  validates the renderer's output.
 */

import { describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  CONNECTION_SOURCE_ID,
  type SourceRegistration,
} from '@recued/contracts';

import {
  EMPTY_WORK_ENTITIES_PANEL_STATE,
  renderWorkEntitiesPanel,
  renderWorkEntityKindSection,
  renderWorkEntitySourceRow,
  type WorkEntitiesPanelState,
} from '../server-settings/work-entities/index.js';

const NOW = 1_700_000_000_000;

const buildBuiltinTask = (overrides: Partial<SourceRegistration> = {}): SourceRegistration => ({
  id: RECUED_BUILTIN_SOURCE_ID('task'),
  top_tier_kind: 'task',
  source_kind: 'builtin',
  source_label: 'Recued built-in',
  write_capable: true,
  mcp_exposed: false,
  enabled: true,
  registered_at: NOW,
  ...overrides,
});

const buildHubspotTask = (
  overrides: Partial<SourceRegistration> = {},
): SourceRegistration => ({
  id: CONNECTION_SOURCE_ID('hubspot', 'conn-42', 'task'),
  top_tier_kind: 'task',
  source_kind: 'connection',
  source_label: 'HubSpot Tasks (conn-42)',
  write_capable: true,
  mcp_exposed: false,
  enabled: true,
  registered_at: NOW + 1,
  ...overrides,
});

const buildBuiltinNote = (overrides: Partial<SourceRegistration> = {}): SourceRegistration => ({
  id: RECUED_BUILTIN_SOURCE_ID('note'),
  top_tier_kind: 'note',
  source_kind: 'builtin',
  source_label: 'Recued built-in',
  write_capable: true,
  mcp_exposed: false,
  enabled: true,
  registered_at: NOW,
  ...overrides,
});

const baseState = (
  overrides: Partial<WorkEntitiesPanelState> = {},
): WorkEntitiesPanelState => ({
  ...EMPTY_WORK_ENTITIES_PANEL_STATE,
  loading: false,
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Source row
// ────────────────────────────────────────────────────────────────

describe('PA11 source row render', () => {
  it('renders both toggles checked when enabled + mcp_exposed are true', () => {
    const html = renderWorkEntitySourceRow({
      source: buildBuiltinTask({ mcp_exposed: true }),
      is_default: false,
    });
    const enabledMatch = html.match(
      /data-action="set-source-enabled"[^>]*checked/,
    );
    const mcpMatch = html.match(
      /data-action="set-source-mcp-exposed"[^>]*checked/,
    );
    expect(enabledMatch).not.toBeNull();
    expect(mcpMatch).not.toBeNull();
  });

  it('renders enabled unchecked when source is disabled', () => {
    const html = renderWorkEntitySourceRow({
      source: buildBuiltinTask({ enabled: false }),
      is_default: false,
    });
    expect(html).toMatch(/rx-source-row-disabled/);
    expect(html).not.toMatch(/data-action="set-source-enabled"[^>]*checked/);
  });

  it('renders the default chip when is_default is true', () => {
    const html = renderWorkEntitySourceRow({
      source: buildBuiltinTask(),
      is_default: true,
    });
    expect(html).toMatch(/rx-source-row-chip-default/);
    expect(html).toMatch(/>default</);
  });

  it('disables both toggles + surfaces error when pending', () => {
    const html = renderWorkEntitySourceRow({
      source: buildBuiltinTask(),
      is_default: false,
      pending: { pending: true, error: 'rpc failed' },
    });
    expect(html).toMatch(/data-action="set-source-enabled"[^>]*disabled/);
    expect(html).toMatch(/data-action="set-source-mcp-exposed"[^>]*disabled/);
    expect(html).toMatch(/rpc failed/);
  });
});

// ────────────────────────────────────────────────────────────────
// Kind section
// ────────────────────────────────────────────────────────────────

describe('PA11 kind section render', () => {
  it('renders the per-kind default-Source dropdown with the pinned id selected', () => {
    const html = renderWorkEntityKindSection({
      kind: 'task',
      sources: [buildBuiltinTask(), buildHubspotTask()],
      default_source_id: CONNECTION_SOURCE_ID('hubspot', 'conn-42', 'task'),
      pending_by_source: {},
    });
    // The HubSpot option carries `selected`.
    expect(html).toMatch(
      new RegExp(
        `<option value="${CONNECTION_SOURCE_ID('hubspot', 'conn-42', 'task')}"[^>]*selected`,
      ),
    );
    // The "(none)" option is not selected.
    expect(html).not.toMatch(/<option value=""[^>]*selected/);
  });

  it('renders empty-state hint when no Sources registered for the kind', () => {
    const html = renderWorkEntityKindSection({
      kind: 'task',
      sources: [], // no Sources at all
      default_source_id: null,
      pending_by_source: {},
    });
    expect(html).toMatch(/0 Sources/);
    expect(html).toMatch(/No task Sources registered yet/);
  });

  it('omits cross-kind Sources from the section', () => {
    const html = renderWorkEntityKindSection({
      kind: 'task',
      sources: [buildBuiltinTask(), buildBuiltinNote()],
      default_source_id: null,
      pending_by_source: {},
    });
    // Heading shows 1, not 2 — only `task` Sources counted.
    expect(html).toMatch(/1 Source\b/);
  });

  it('marks disabled Sources in the dropdown labels', () => {
    const html = renderWorkEntityKindSection({
      kind: 'task',
      sources: [buildHubspotTask({ enabled: false })],
      default_source_id: null,
      pending_by_source: {},
    });
    expect(html).toMatch(/HubSpot Tasks \(conn-42\) \(disabled\)/);
  });

  it('disables the default-Source dropdown while pending', () => {
    const html = renderWorkEntityKindSection({
      kind: 'task',
      sources: [buildBuiltinTask()],
      default_source_id: null,
      pending_by_source: {},
      pending_default: { pending: true, error: null },
    });
    expect(html).toMatch(
      /data-action="set-default-source"[^>]*disabled/,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Panel
// ────────────────────────────────────────────────────────────────

describe('PA11 panel render', () => {
  it('renders loading placeholder when loading + sources empty', () => {
    const html = renderWorkEntitiesPanel(
      baseState({ loading: true, sources: [] }),
    );
    expect(html).toMatch(/Loading Work Entity Sources/);
  });

  it('renders inline error when state.error is set', () => {
    const html = renderWorkEntitiesPanel(baseState({ error: 'list rpc failed' }));
    expect(html).toMatch(/list rpc failed/);
  });

  it('renders one section per work-entity kind', () => {
    const html = renderWorkEntitiesPanel(
      baseState({
        sources: [buildBuiltinTask(), buildBuiltinNote()],
      }),
    );
    expect(html).toMatch(/data-kind="task"/);
    expect(html).toMatch(/data-kind="note"/);
    expect(html).toMatch(/data-kind="commitment"/);
    expect(html).toMatch(/data-kind="project"/);
  });

  it('threads the per-kind default through to the kind section', () => {
    const html = renderWorkEntitiesPanel(
      baseState({
        sources: [buildBuiltinTask()],
        defaults_by_kind: {
          task: RECUED_BUILTIN_SOURCE_ID('task'),
        },
      }),
    );
    expect(html).toMatch(
      new RegExp(
        `<option value="${RECUED_BUILTIN_SOURCE_ID('task')}"[^>]*selected`,
      ),
    );
  });
});
