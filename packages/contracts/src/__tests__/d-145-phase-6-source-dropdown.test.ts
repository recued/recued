/** D-145 PA6 — Source dropdown options builder + selection helpers.
 *
 *  Pin per § A.2.2 (resolver behavior) + § Phase PA6 (Source dropdown
 *  component populated from source_registry):
 *    - All-Sources sentinel always first
 *    - Registered Sources matching `kind` follow in registration order
 *    - Sources for OTHER kinds are filtered out
 *    - resolveCreateDialogSourceId obeys preference order (selected → built-in
 *      → first write-capable; there is no stored default step)
 *    - dropdown <-> page-state mapping (selected_source_id ↔ dropdown id)
 */

import { describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  SOURCE_DROPDOWN_ALL_LABEL,
  SOURCE_DROPDOWN_ALL_VALUE,
  buildSourceDropdownOptions,
  dropdownIdToSelectedSourceId,
  resolveCreateDialogSourceId,
  selectedSourceIdToDropdownId,
  type SourceRegistration,
} from '../index.js';

const NOW = 1_700_000_000_000;

const builtinTask = (): SourceRegistration => ({
  id: RECUED_BUILTIN_SOURCE_ID('task'),
  top_tier_kind: 'task',
  source_kind: 'builtin',
  source_label: 'Recued built-in (task)',
  write_capable: true,
  registered_at: NOW,
});

const hubspotTask = (over: Partial<SourceRegistration> = {}): SourceRegistration => ({
  id: 'hubspot.acme.task',
  top_tier_kind: 'task',
  source_kind: 'connection',
  source_label: 'HubSpot tasks (acme)',
  write_capable: true,
  registered_at: NOW + 1,
  ...over,
});

const builtinNote = (): SourceRegistration => ({
  id: RECUED_BUILTIN_SOURCE_ID('note'),
  top_tier_kind: 'note',
  source_kind: 'builtin',
  source_label: 'Recued built-in (note)',
  write_capable: true,
  registered_at: NOW + 2,
});

describe('D-145 PA6 — buildSourceDropdownOptions', () => {
  it('prepends the All-Sources sentinel as the first option', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask()]);
    expect(opts[0].id).toBe(SOURCE_DROPDOWN_ALL_VALUE);
    expect(opts[0].label).toBe(SOURCE_DROPDOWN_ALL_LABEL);
    expect(opts[0].source_kind).toBe('sentinel');
    expect(opts[0].write_capable).toBe(false);
  });

  it('appends registered Sources matching the kind in given order', () => {
    const opts = buildSourceDropdownOptions('task', [
      builtinTask(),
      hubspotTask(),
    ]);
    expect(opts.slice(1).map((o) => o.id)).toEqual([
      RECUED_BUILTIN_SOURCE_ID('task'),
      'hubspot.acme.task',
    ]);
  });

  it('filters out Sources for OTHER kinds', () => {
    const opts = buildSourceDropdownOptions('task', [
      builtinTask(),
      builtinNote(),
    ]);
    expect(opts.slice(1).map((o) => o.id)).toEqual([
      RECUED_BUILTIN_SOURCE_ID('task'),
    ]);
  });

  it('still returns the sentinel when no Sources match the kind', () => {
    const opts = buildSourceDropdownOptions('task', [builtinNote()]);
    expect(opts.length).toBe(1);
    expect(opts[0].id).toBe(SOURCE_DROPDOWN_ALL_VALUE);
  });

  // The sentinel's `mcp_exposed` union assertion lived here until the flag was
  // deleted (D-187 Sources half). Nothing replaces it: the dropdown is a
  // data-plane picker, and AI read access is a contract grant, not a property
  // the option shape carries.
  it('copies source_kind / write_capable onto each option', () => {
    const opts = buildSourceDropdownOptions('task', [hubspotTask()]);
    const hub = opts[1];
    expect(hub.source_kind).toBe('connection');
    expect(hub.write_capable).toBe(true);
    expect(hub.label).toBe('HubSpot tasks (acme)');
  });
});

describe('D-145 PA6 — resolveCreateDialogSourceId', () => {
  it('returns null when no Source is write-capable', () => {
    const sources = [
      hubspotTask({ write_capable: false }),
      hubspotTask({
        id: 'salesforce.acme.task',
        source_label: 'Salesforce tasks (acme)',
        write_capable: false,
      }),
    ];
    expect(resolveCreateDialogSourceId('task', null, sources)).toBeNull();
  });

  it('honors the selected Source when it is write-capable', () => {
    const sources = [builtinTask(), hubspotTask()];
    expect(
      resolveCreateDialogSourceId('task', 'hubspot.acme.task', sources),
    ).toBe('hubspot.acme.task');
  });

  it('falls through selected Source if read-only', () => {
    const sources = [
      builtinTask(),
      hubspotTask({ write_capable: false }),
    ];
    expect(
      resolveCreateDialogSourceId('task', 'hubspot.acme.task', sources),
    ).toBe(RECUED_BUILTIN_SOURCE_ID('task'));
  });

  // ⛔ 'honors default-Source memory when selected is null' is DELETED, not
  // rewritten: with the default gone, a null selection falls straight to the
  // local built-in, which the next case already pins. Left as-is it would have
  // asserted 'hubspot.acme.task' and FAILED at runtime while typechecking
  // clean — the same shape that slipped past the mcp_exposed round.

  it('falls back to Recued built-in when there is no usable selection', () => {
    const sources = [builtinTask(), hubspotTask()];
    expect(resolveCreateDialogSourceId('task', null, sources)).toBe(
      RECUED_BUILTIN_SOURCE_ID('task'),
    );
  });

  it('falls back to first write-capable when Recued built-in is missing', () => {
    const sources = [hubspotTask({ id: 'asana.proj.task' })];
    expect(resolveCreateDialogSourceId('task', null, sources)).toBe(
      'asana.proj.task',
    );
  });
});

describe('D-145 PA6 — dropdown ↔ page-state mapping', () => {
  it('selectedSourceIdToDropdownId returns sentinel for null', () => {
    expect(selectedSourceIdToDropdownId(null)).toBe(SOURCE_DROPDOWN_ALL_VALUE);
  });

  it('selectedSourceIdToDropdownId echoes concrete ids', () => {
    expect(selectedSourceIdToDropdownId('hubspot.acme.task')).toBe(
      'hubspot.acme.task',
    );
  });

  it('dropdownIdToSelectedSourceId maps sentinel to null', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask()]);
    expect(dropdownIdToSelectedSourceId(SOURCE_DROPDOWN_ALL_VALUE, opts)).toBeNull();
  });

  it('dropdownIdToSelectedSourceId returns concrete id when registered', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask()]);
    expect(
      dropdownIdToSelectedSourceId(RECUED_BUILTIN_SOURCE_ID('task'), opts),
    ).toBe(RECUED_BUILTIN_SOURCE_ID('task'));
  });

  it('dropdownIdToSelectedSourceId returns undefined for unregistered ids', () => {
    const opts = buildSourceDropdownOptions('task', [builtinTask()]);
    expect(dropdownIdToSelectedSourceId('hubspot.unknown.task', opts)).toBeUndefined();
  });
});
