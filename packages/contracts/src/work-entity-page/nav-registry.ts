/** D-145 PA6 — per-kind navigation registry.
 *
 *  Closed map keyed on `WorkEntityKind`. Each entry pins the icon name
 *  + plural / singular labels + empty-state copy used by primary nav
 *  + page chrome.  PA6 ships the four work entities; future
 *  top_tier_kind UIs land their own registrations after marketplace
 *  review (not in scope at PA6).
 *
 *  Spec: docs/d-145-spec.md § Phase PA6 (per-kind icon registration in
 *  primary UI nav).
 */

import { WORK_ENTITY_KINDS, type WorkEntityKind } from '../work-entities.js';
import type { WorkEntityNavSpec } from './types.js';

/** Identity that accepts ONLY an order listing every `WorkEntityKind`.
 *
 *  ⚠ The fence exists because the obvious annotation does NOT hold one.
 *  `WORK_ENTITY_NAV_ORDER: readonly WorkEntityKind[]` constrains the
 *  members to be kinds but says nothing about coverage — a SHORT array
 *  typechecks perfectly, so a newly added kind was silently absent from
 *  the nav strip while `WORK_ENTITY_NAV` (a real `Record<>`) forced its
 *  registration. Registered and unreachable is the worst pair.
 *
 *  A missing kind now makes the trailing parameter required, so the
 *  call fails to compile and the error names the kind. */
const exhaustiveKindOrder = <const T extends readonly WorkEntityKind[]>(
  order: T,
  ..._everyKindIsListed: Exclude<WorkEntityKind, T[number]> extends never
    ? []
    : [missing_from_WORK_ENTITY_NAV_ORDER: Exclude<WorkEntityKind, T[number]>]
): readonly WorkEntityKind[] => Object.freeze(order);

/** Stable per-kind nav order for the primary nav strip. PA6 lays out
 *  task → commitment → note → project — ordered by "what the user
 *  most often needs to act on first" (active tasks + open commitments
 *  ahead of reference notes + container projects). */
export const WORK_ENTITY_NAV_ORDER: readonly WorkEntityKind[] = exhaustiveKindOrder([
  'task',
  'commitment',
  'booking',
  'note',
  'project',
]);

/** Closed registry keyed on `WorkEntityKind`. The `icon_name` value
 *  matches a registered `IconName` in `@recued/ui-shared/icons.generated`
 *  — adding a top_tier_kind UI requires both a registration here AND
 *  a matching SVG entry over there. */
export const WORK_ENTITY_NAV: Readonly<Record<WorkEntityKind, WorkEntityNavSpec>> =
  Object.freeze({
    task: {
      kind: 'task',
      icon_name: 'task',
      plural_label: 'Tasks',
      singular_label: 'Task',
      empty_state_copy:
        'No tasks yet. Create one or wait for an inbound Source to populate this list.',
    },
    note: {
      kind: 'note',
      icon_name: 'note',
      plural_label: 'Notes',
      singular_label: 'Note',
      empty_state_copy:
        'No notes yet. Capture context or jot a quick reference here.',
    },
    commitment: {
      kind: 'commitment',
      icon_name: 'commitment',
      plural_label: 'Commitments',
      singular_label: 'Commitment',
      empty_state_copy:
        'No commitments yet. Promises and obligations show up here as Recued extracts them.',
    },
    project: {
      kind: 'project',
      icon_name: 'project',
      plural_label: 'Projects',
      singular_label: 'Project',
      empty_state_copy:
        'No projects yet. Group tasks and notes into a project to see activity at a glance.',
    },
    booking: {
      kind: 'booking',
      icon_name: 'booking',
      plural_label: 'Bookings',
      singular_label: 'Booking',
      empty_state_copy:
        'No bookings yet. Approving a reservation from your Reception inbox creates one here, '
        + 'alongside the calendar event it books.',
    },
  });

/** Lookup by kind. Throws on unknown kind so callers don't silently
 *  render against an undefined spec. */
export const workEntityNavSpec = (kind: WorkEntityKind): WorkEntityNavSpec => {
  const spec = WORK_ENTITY_NAV[kind];
  if (!spec) {
    throw new Error(
      `workEntityNavSpec: unknown work-entity kind '${kind}' — must be one of ${WORK_ENTITY_KINDS.join(' / ')}`,
    );
  }
  return spec;
};

/** Stable iteration helper — yields nav specs in `WORK_ENTITY_NAV_ORDER`
 *  rather than `Object.values` insertion order so renderer output is
 *  deterministic across runtimes. */
export const workEntityNavSpecsInOrder = (): readonly WorkEntityNavSpec[] =>
  WORK_ENTITY_NAV_ORDER.map((kind) => WORK_ENTITY_NAV[kind]);
