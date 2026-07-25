/** D-123 Phase 5 — Housekeeping preset radio picker.
 *
 *  Four user-visible presets: light / balanced / aggressive / custom.
 *  The fifth preset value `'off'` is intentionally not surfaced —
 *  power users edit it via the config-rpc directly per the spec
 *  (§Constants).
 *
 *  Spec: `docs/d-123-spec.md` §5.2. */

import type { HousekeepingPreset } from '@recued/contracts';
import { e } from '../../template.js';

interface PresetChoice {
  value: Exclude<HousekeepingPreset, 'off'>;
  label: string;
  description: string;
}

const CHOICES: readonly PresetChoice[] = [
  {
    value: 'light',
    label: 'Light',
    description: 'Every 60 min when idle, 30 s budget per cycle.',
  },
  {
    value: 'balanced',
    label: 'Balanced (default)',
    description: 'Every 15 min when idle, 60 s budget per cycle.',
  },
  {
    value: 'aggressive',
    label: 'Aggressive',
    description: 'Continuously when idle for 5 min+, 120 s budget per cycle.',
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Pick budget, interval, and quiet-hours window.',
  },
];

export interface HousekeepingPresetPickerProps {
  /** Currently active preset (per the persisted config row). */
  active: HousekeepingPreset;
  /** Pending draft preset, if the user has clicked a different radio
   *  but not yet saved. Drives the radio's `checked` state. Null →
   *  show the active preset as checked. */
  draft: HousekeepingPreset | null;
  /** True while a `housekeeping.config.write` is in flight. Disables
   *  every radio. */
  saving: boolean;
}

export const renderHousekeepingPresetPicker = (
  props: HousekeepingPresetPickerProps,
): string => {
  const selected = props.draft ?? props.active;
  return `
    <fieldset class="housekeeping-preset-picker">
      <legend>Schedule</legend>
      ${CHOICES.map((choice) => `
        <label class="housekeeping-preset-choice">
          <input
            type="radio"
            name="housekeeping-preset"
            value="${e(choice.value)}"
            data-action="housekeeping-preset-pick"
            data-preset="${e(choice.value)}"
            ${selected === choice.value ? 'checked' : ''}
            ${props.saving ? 'disabled' : ''}
          />
          <span class="housekeeping-preset-label">${e(choice.label)}</span>
          <span class="housekeeping-preset-desc">${e(choice.description)}</span>
        </label>
      `).join('')}
    </fieldset>
  `;
};
