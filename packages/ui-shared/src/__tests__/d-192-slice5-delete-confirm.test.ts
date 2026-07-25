/** D-192 slice 5 — the connections delete-confirm modal render.
 *
 *  `renderConnectionsPage` grows a confirm modal when `state.deleteConfirm` is
 *  non-null. The "also remove the [N] item(s)" opt-in checkbox appears ONLY when
 *  the `previewPurge` count resolved to > 0; a null count (loading / unwired /
 *  non-purgeable) or a 0 count renders a plain confirm. Default unchecked.
 */

import { describe, expect, it } from 'vitest';
import {
  renderConnectionsPage,
  initialConnectionsPageState,
  type ConnectionsPageState,
  type ConnectionsDeleteConfirmState,
} from '../connections/index.js';

const baseState = (overrides?: Partial<ConnectionsPageState>): ConnectionsPageState => ({
  ...initialConnectionsPageState(),
  connections: [
    { name: 'acme-hubspot', kind: 'api' as const, display_name: 'Acme HubSpot' },
  ],
  ...(overrides ?? {}),
});

const confirm = (over?: Partial<ConnectionsDeleteConfirmState>): ConnectionsDeleteConfirmState => ({
  kind: 'api',
  name: 'acme-hubspot',
  count: null,
  removeMirror: false,
  deleting: false,
  ...(over ?? {}),
});

describe('D-192 slice 5 — delete-confirm modal', () => {
  it('renders no confirm markup when deleteConfirm is null', () => {
    const html = renderConnectionsPage(baseState());
    expect(html).not.toContain('connections-delete-backdrop');
    expect(html).not.toContain('connections-delete-confirm');
  });

  it('renders the confirm (title + Remove/Cancel) when open', () => {
    const html = renderConnectionsPage(baseState({ deleteConfirm: confirm() }));
    expect(html).toContain('connections-delete-backdrop');
    expect(html).toContain('Remove acme-hubspot?');
    expect(html).toContain('data-action="connections-delete-confirm"');
    expect(html).toContain('data-action="connections-delete-cancel"');
    expect(html).toContain('>Remove<'); // the danger button label (not "Removing…")
  });

  it('shows the opt-in checkbox ONLY when the count resolved to > 0', () => {
    const withCount = renderConnectionsPage(baseState({ deleteConfirm: confirm({ count: 5 }) }));
    expect(withCount).toContain('data-action="connections-delete-toggle-mirror"');
    expect(withCount).toContain('Also remove the 5 items this connection synced');

    // null count (still loading / unwired / non-purgeable) → no checkbox
    const nullCount = renderConnectionsPage(baseState({ deleteConfirm: confirm({ count: null }) }));
    expect(nullCount).not.toContain('connections-delete-toggle-mirror');
    expect(nullCount).toContain('Its synced data is kept.');

    // zero count → nothing to remove → no checkbox
    const zeroCount = renderConnectionsPage(baseState({ deleteConfirm: confirm({ count: 0 }) }));
    expect(zeroCount).not.toContain('connections-delete-toggle-mirror');
  });

  it('singularizes the item count', () => {
    const html = renderConnectionsPage(baseState({ deleteConfirm: confirm({ count: 1 }) }));
    expect(html).toContain('Also remove the 1 item this connection synced');
    expect(html).not.toContain('1 items');
  });

  it('reflects the checkbox state (default unchecked; checked when opted in)', () => {
    const unchecked = renderConnectionsPage(baseState({ deleteConfirm: confirm({ count: 3 }) }));
    // the checkbox input carries the toggle action but no `checked` attribute
    expect(unchecked).toContain('data-action="connections-delete-toggle-mirror"');
    expect(unchecked).not.toMatch(/data-action="connections-delete-toggle-mirror"[^>]*checked/);

    const checked = renderConnectionsPage(
      baseState({ deleteConfirm: confirm({ count: 3, removeMirror: true }) }),
    );
    expect(checked).toMatch(/checked/);
  });

  it('disables the buttons + shows Removing… while deleting', () => {
    const html = renderConnectionsPage(
      baseState({ deleteConfirm: confirm({ count: 3, removeMirror: true, deleting: true }) }),
    );
    expect(html).toContain('Removing…');
    // both confirm + cancel are disabled mid-delete
    expect(html).toMatch(/data-action="connections-delete-confirm"[^>]*disabled|disabled[^>]*data-action="connections-delete-confirm"/);
  });

  it('escapes the connection name (no HTML injection in the title)', () => {
    const html = renderConnectionsPage(
      baseState({ deleteConfirm: confirm({ name: 'a<script>b' }) }),
    );
    expect(html).not.toContain('<script>b');
    expect(html).toContain('a&lt;script&gt;b');
  });
});
