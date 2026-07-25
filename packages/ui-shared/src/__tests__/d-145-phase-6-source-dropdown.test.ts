/** D-145 PA6 — Source dropdown rendering.
 *
 *  Pin per § Phase PA6 (Source dropdown component populated from
 *  source_registry):
 *    - Renders the All-Sources sentinel as the first option.
 *    - Selected option carries `selected`.
 *    - Each option has data-source-kind for affordance styling.
 *    - data-action="select-source" for host event delegation.
 *    - Affordance chips reflect write_capable / mcp_exposed.
 *    - XSS-safe (label / id escape).
 */

import { describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  SOURCE_DROPDOWN_ALL_VALUE,
  buildSourceDropdownOptions,
  type SourceDropdownOption,
} from '@recued/contracts';

import {
  renderSourceAffordanceChips,
  renderSourceDropdown,
} from '../work-entity-page/source-dropdown.js';

const NOW = 1_700_000_000_000;

const builtinTask = () => ({
  id: RECUED_BUILTIN_SOURCE_ID('task'),
  top_tier_kind: 'task' as const,
  source_kind: 'builtin' as const,
  source_label: 'Recued built-in (task)',
  write_capable: true,
  mcp_exposed: true,
  registered_at: NOW,
});

const hubspotTask = () => ({
  id: 'hubspot.acme.task',
  top_tier_kind: 'task' as const,
  source_kind: 'connection' as const,
  source_label: 'HubSpot tasks (acme)',
  write_capable: true,
  mcp_exposed: false,
  registered_at: NOW + 1,
});

describe('D-145 PA6 — renderSourceDropdown', () => {
  it('renders <select> with data-action="select-source"', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask()]);
    const html = renderSourceDropdown({ options: opts, selected_source_id: null });
    expect(html).toContain('<select');
    expect(html).toContain('data-action="select-source"');
  });

  it('first option is the All-Sources sentinel', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask(), hubspotTask()]);
    const html = renderSourceDropdown({ options: opts, selected_source_id: null });
    const optionMatches = [...html.matchAll(/<option[^>]*>/g)];
    expect(optionMatches[0][0]).toContain(`value="${SOURCE_DROPDOWN_ALL_VALUE}"`);
    expect(optionMatches[0][0]).toContain('selected');
  });

  it('marks concrete Source as selected when chosen', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask(), hubspotTask()]);
    const html = renderSourceDropdown({
      options: opts,
      selected_source_id: 'hubspot.acme.task',
    });
    expect(html).toMatch(/value="hubspot.acme.task"[^>]*selected/);
    // Sentinel should NOT be selected.
    expect(html).not.toMatch(
      new RegExp(`value="${SOURCE_DROPDOWN_ALL_VALUE}"[^>]*selected`),
    );
  });

  it('each option carries data-source-kind for styling', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask(), hubspotTask()]);
    const html = renderSourceDropdown({ options: opts, selected_source_id: null });
    expect(html).toContain('data-source-kind="sentinel"');
    expect(html).toContain('data-source-kind="builtin"');
    expect(html).toContain('data-source-kind="connection"');
  });

  it('disabled prop adds disabled attribute', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask()]);
    const enabled = renderSourceDropdown({
      options: opts,
      selected_source_id: null,
    });
    const disabled = renderSourceDropdown({
      options: opts,
      selected_source_id: null,
      disabled: true,
    });
    expect(enabled).not.toMatch(/<select[\s\S]*?\sdisabled[\s>]/);
    expect(disabled).toMatch(/<select[\s\S]*?\sdisabled[\s>]/);
  });

  it('renders Loading… placeholder when options array is empty (Codex P2 fold)', () => {
    const html = renderSourceDropdown({
      options: [],
      selected_source_id: null,
    });
    // Disabled placeholder option is rendered.
    expect(html).toContain('Loading Sources…');
    expect(html).toMatch(/<option[^>]*disabled[^>]*selected[^>]*>Loading Sources/);
    // Select itself is disabled (no options to pick).
    expect(html).toMatch(/<select[\s\S]*?\sdisabled[\s>]/);
  });

  it('escapes HTML in source labels', () => {
    const malicious: SourceDropdownOption[] = [
      {
        id: 'evil',
        label: '<script>alert(1)</script>',
        source_kind: 'connection',
        write_capable: false,
        mcp_exposed: false,
      },
    ];
    const html = renderSourceDropdown({
      options: malicious,
      selected_source_id: null,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('D-145 PA6 — renderSourceAffordanceChips', () => {
  it('returns empty string for the sentinel option', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask()]);
    expect(renderSourceAffordanceChips(opts[0])).toBe('');
  });

  it('returns empty string for undefined option', () => {
    expect(renderSourceAffordanceChips(undefined)).toBe('');
  });

  it('renders write chip for write-capable Sources', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask()]);
    const html = renderSourceAffordanceChips(opts[1]);
    expect(html).toContain('work-entity-source-chip-write');
    expect(html).toContain('>write<');
  });

  it('renders read-only chip for read-only Sources', () => {
    const opts = buildSourceDropdownOptions('task', [
      { ...hubspotTask(), write_capable: false },
    ]);
    const html = renderSourceAffordanceChips(opts[1]);
    expect(html).toContain('work-entity-source-chip-readonly');
    expect(html).toContain('>read-only<');
  });

  it('renders MCP chip for mcp-exposed Sources', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask()]);
    const html = renderSourceAffordanceChips(opts[1]);
    expect(html).toContain('work-entity-source-chip-mcp');
    expect(html).toContain('>MCP<');
  });

  it('omits MCP chip when not exposed', () => {
    const opts = buildSourceDropdownOptions('task', [hubspotTask()]);
    const html = renderSourceAffordanceChips(opts[1]);
    expect(html).not.toContain('work-entity-source-chip-mcp');
  });
});
