/** D-138 Phase 5 — vendor-merge preview dialog + failure-banner tests.
 *
 *  Covers:
 *    - `renderVendorMergePreviewDialog` — closed state returns empty;
 *      open + unarmed renders the arm-action button; armed renders
 *      the fire-action button + the second-click hint; degraded path
 *      renders the local-only explanation; per-field outcome rows
 *      escape user-supplied strings + highlight winners; error banner
 *      surfaces when `state.error` is set.
 *    - `renderUpstreamMergeFailureBanner` — empty rows = empty
 *      output; one banner per row; retry + discard data-action
 *      buttons stamped with `outbox-id`; busy flag disables both. */

import { describe, expect, it } from 'vitest';

import {
  renderUpstreamMergeFailureBanner,
  renderVendorMergePreviewDialog,
  VENDOR_MERGE_DIALOG_ACTIONS,
  type UpstreamMergeFailureBannerState,
  type VendorMergePreviewState,
} from '../contacts/index.js';
import type { UpstreamMergeOutboxRow } from '@recued/contracts';

const baseState = (overrides: Partial<VendorMergePreviewState> = {}): VendorMergePreviewState => ({
  open: true,
  vendor: 'hubspot',
  object_type: 'hubspot:contact',
  vendor_semantics_summary: 'HubSpot will absorb A into B. Cannot be undone.',
  field_outcomes: [],
  dispatchable: true,
  survivor_platform_id: 'master_id',
  loser_platform_id: 'victim_id',
  armed: false,
  saving: false,
  ...overrides,
});

describe('D-138 P5 — vendor-merge preview dialog', () => {
  it('returns the empty string when closed', () => {
    expect(renderVendorMergePreviewDialog({ ...baseState(), open: false })).toBe('');
  });

  it('first-click stamps the arm action; second-click stamps fire', () => {
    const unarmed = renderVendorMergePreviewDialog(baseState({ armed: false }));
    expect(unarmed).toContain(`data-action="${VENDOR_MERGE_DIALOG_ACTIONS.arm}"`);
    expect(unarmed).not.toContain(`data-action="${VENDOR_MERGE_DIALOG_ACTIONS.fire}"`);

    const armed = renderVendorMergePreviewDialog(baseState({ armed: true }));
    expect(armed).toContain(`data-action="${VENDOR_MERGE_DIALOG_ACTIONS.fire}"`);
    // Cancel button still renders.
    expect(armed).toContain(`data-action="${VENDOR_MERGE_DIALOG_ACTIONS.cancel}"`);
  });

  it('armed state surfaces a "click again" hint and shifts the button to danger variant', () => {
    const armed = renderVendorMergePreviewDialog(baseState({ armed: true }));
    expect(armed).toContain('Click ');
    expect(armed).toContain('again to fire');
    // The danger variant wraps the button in `rx-btn-danger`.
    expect(armed).toMatch(/rx-btn-danger/);
  });

  it('saving disables both buttons', () => {
    const saving = renderVendorMergePreviewDialog(baseState({ armed: true, saving: true }));
    // Disabled buttons render `disabled` attr.
    const disabledMatches = saving.match(/disabled/g) ?? [];
    expect(disabledMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('renders Salesforce label when vendor is salesforce', () => {
    const html = renderVendorMergePreviewDialog(
      baseState({ vendor: 'salesforce', object_type: 'salesforce:lead' }),
    );
    expect(html).toContain('Also merge in Salesforce');
  });

  it('degraded path (dispatchable=false) renders the local-only explanation + no field table', () => {
    const html = renderVendorMergePreviewDialog(
      baseState({
        vendor: 'salesforce',
        object_type: 'salesforce:contact',
        dispatchable: false,
        vendor_semantics_summary: 'Salesforce does not expose Contact merge…',
        field_outcomes: [],
      }),
    );
    expect(html).toContain('Local-only merge');
    // Confirmation labels reflect the local-only path.
    expect(html).toContain('I understand');
    expect(html).toContain('merge locally only');
    // No field table.
    expect(html).not.toContain('rx-vmp-fields');
    // Survivor / loser ids line is suppressed (those are vendor-side).
    expect(html).not.toContain('rx-vmp-ids');
  });

  it('per-field outcome rows escape values + highlight winner', () => {
    const html = renderVendorMergePreviewDialog(
      baseState({
        field_outcomes: [
          {
            field: 'phone',
            survivor_value: '+1 555 1111',
            loser_value: '<script>alert("x")</script>',
            winner: 'survivor',
          },
        ],
      }),
    );
    // Renderer escaped the script tag.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // Winner cell carries the rx-vmp-winner class.
    expect(html).toMatch(/rx-vmp-survivor[^"]*rx-vmp-winner/);
  });

  it('renders unknown winner with "decides at merge time" rationale', () => {
    const html = renderVendorMergePreviewDialog(
      baseState({
        field_outcomes: [
          { field: 'phone', survivor_value: 'x', loser_value: 'y', winner: 'unknown' },
        ],
      }),
    );
    expect(html).toContain('decides at merge time');
  });

  it('error state renders the error message via inline error', () => {
    const html = renderVendorMergePreviewDialog(
      baseState({
        error: 'Vendor returned 503; please retry shortly.',
      }),
    );
    expect(html).toContain('Vendor returned 503');
    expect(html).toMatch(/rx-msg-error/);
  });

  it('exports the action-name constants', () => {
    expect(VENDOR_MERGE_DIALOG_ACTIONS.arm).toBe('vendor-merge-arm');
    expect(VENDOR_MERGE_DIALOG_ACTIONS.fire).toBe('vendor-merge-fire');
    expect(VENDOR_MERGE_DIALOG_ACTIONS.cancel).toBe('vendor-merge-cancel');
  });
});

describe('D-138 P5 — upstream-merge failure banner', () => {
  const buildRow = (overrides: Partial<UpstreamMergeOutboxRow> = {}): UpstreamMergeOutboxRow => ({
    id: 'outbox_1',
    approval_id: 'app_1',
    vendor: 'hubspot',
    object_type: 'hubspot:contact',
    candidate_ids: ['cand_1'],
    survivor_email: 'survivor@example.com',
    loser_emails: ['loser@example.com'],
    vendor_pairs: [{ survivor_platform_id: 'm', loser_platform_id: 'v' }],
    idempotency_key: 'sha256_xxx',
    state: 'vendor_merge_failed',
    attempts: 3,
    last_error: { code: 'retry_budget_exhausted', message: '503 after 3 attempts' },
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  });

  it('returns the empty string when there are no rows', () => {
    expect(renderUpstreamMergeFailureBanner({ rows: [] })).toBe('');
  });

  it('renders one banner per row with retry + discard actions stamped with outbox-id', () => {
    const html = renderUpstreamMergeFailureBanner({
      rows: [buildRow(), buildRow({ id: 'outbox_2' })],
    });
    expect(html).toContain('data-action="upstream-merge-retry"');
    expect(html).toContain('data-action="upstream-merge-discard"');
    expect(html).toContain('data-outbox-id="outbox_1"');
    expect(html).toContain('data-outbox-id="outbox_2"');
    // Both retry buttons are rendered.
    const retryCount = (html.match(/data-action="upstream-merge-retry"/g) ?? []).length;
    expect(retryCount).toBe(2);
  });

  it('busy flag per row disables that row\'s buttons', () => {
    const html = renderUpstreamMergeFailureBanner({
      rows: [buildRow()],
      rowsBusy: { outbox_1: true },
    });
    const disabledMatches = html.match(/disabled/g) ?? [];
    expect(disabledMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('renders the error code + message', () => {
    const html = renderUpstreamMergeFailureBanner({ rows: [buildRow()] });
    expect(html).toContain('retry_budget_exhausted');
    expect(html).toContain('503 after 3 attempts');
  });

  it('escapes user-supplied error message', () => {
    const html = renderUpstreamMergeFailureBanner({
      rows: [buildRow({ last_error: { code: 'evil', message: '<script>x</script>' } })],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('Salesforce row labels with Salesforce vendor name', () => {
    const html = renderUpstreamMergeFailureBanner({
      rows: [buildRow({ vendor: 'salesforce', object_type: 'salesforce:lead' })],
    });
    expect(html).toContain('Salesforce');
  });
});
