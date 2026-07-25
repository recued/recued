/** D-123 Phase 5 — Custom-window form fields.
 *
 *  Visible only when the active draft preset is `'custom'`. The user
 *  picks: cycle budget (ms), cycle interval (minutes), and a daily
 *  hour-pair window. Bounds are advisory — the rpc enforces them
 *  server-side and surfaces failures inline.
 *
 *  Spec: `docs/d-123-spec.md` §5.2. */

import {
  HOUSEKEEPING_CYCLE_BUDGET_MAX_MS,
  HOUSEKEEPING_CYCLE_BUDGET_MIN_MS,
  type HousekeepingConfigRow,
} from '@recued/contracts';
import { e } from '../../template.js';
import type { HousekeepingCustomDraft } from './state.js';

export interface HousekeepingCustomWindowFieldsProps {
  /** Persisted config row — used to seed the inputs when the draft
   *  hasn't touched a field yet. */
  config: HousekeepingConfigRow;
  /** Pending edits the user has typed into the inputs. Each field is
   *  optional — undefined ⇒ "show the persisted value". */
  draft: HousekeepingCustomDraft;
  /** True while saving. Disables every input. */
  saving: boolean;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** Pick the value to render — pending draft wins; falls back to
 *  persisted config; otherwise empty (custom defaults still
 *  unwritten). */
const valueOr = <T>(draft: T | undefined, persisted: T | undefined): T | undefined =>
  draft !== undefined ? draft : persisted;

export const renderHousekeepingCustomWindowFields = (
  props: HousekeepingCustomWindowFieldsProps,
): string => {
  const budget = valueOr(props.draft.cycle_budget_ms, props.config.cycle_budget_ms);
  const interval = valueOr(
    props.draft.cycle_interval_minutes,
    props.config.cycle_interval_minutes,
  );
  const startHour = valueOr(
    props.draft.custom_window_start_hour,
    props.config.custom_window_start_hour,
  );
  const endHour = valueOr(
    props.draft.custom_window_end_hour,
    props.config.custom_window_end_hour,
  );

  const renderHourSelect = (id: string, action: string, value: number | undefined): string => `
    <select
      id="${e(id)}"
      data-action="${e(action)}"
      class="housekeeping-custom-hour"
      ${props.saving ? 'disabled' : ''}
    >
      <option value="">—</option>
      ${HOURS.map((h) => `
        <option value="${h}" ${value === h ? 'selected' : ''}>${pad2(h)}:00</option>
      `).join('')}
    </select>
  `;

  return `
    <div class="housekeeping-custom-fields">
      <div class="housekeeping-custom-row">
        <label for="housekeeping-custom-budget">Cycle budget (ms)</label>
        <input
          id="housekeeping-custom-budget"
          type="number"
          inputmode="numeric"
          min="${HOUSEKEEPING_CYCLE_BUDGET_MIN_MS}"
          max="${HOUSEKEEPING_CYCLE_BUDGET_MAX_MS}"
          value="${budget !== undefined ? e(String(budget)) : ''}"
          data-action="housekeeping-custom-budget"
          ${props.saving ? 'disabled' : ''}
        />
        <span class="housekeeping-custom-hint">[${HOUSEKEEPING_CYCLE_BUDGET_MIN_MS}, ${HOUSEKEEPING_CYCLE_BUDGET_MAX_MS}]</span>
      </div>
      <div class="housekeeping-custom-row">
        <label for="housekeeping-custom-interval">Cycle interval (minutes)</label>
        <input
          id="housekeeping-custom-interval"
          type="number"
          inputmode="numeric"
          min="0"
          value="${interval !== undefined ? e(String(interval)) : ''}"
          data-action="housekeeping-custom-interval"
          ${props.saving ? 'disabled' : ''}
        />
      </div>
      <div class="housekeeping-custom-row housekeeping-custom-window">
        <span class="housekeeping-custom-window-label">Run between</span>
        ${renderHourSelect('housekeeping-custom-start', 'housekeeping-custom-start', startHour)}
        <span class="housekeeping-custom-window-sep">and</span>
        ${renderHourSelect('housekeeping-custom-end', 'housekeeping-custom-end', endHour)}
        <span class="housekeeping-custom-hint">(local time, end exclusive — crosses midnight when start &gt; end)</span>
      </div>
    </div>
  `;
};

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));
